/**
 * The authenticated MCP endpoint (/mcp).
 *
 * OAuthProvider calls this only after validating the bearer token, and passes the decrypted
 * grant props (the linked Google accounts' refresh tokens) in ctx.props.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env, UserProps } from "./env.js";
import { registerTaskTools } from "./tools.js";
import { registerSheetsTools } from "./sheets-tools.js";
import { registerDocsTools } from "./docs-tools.js";
import { TasksApi } from "./tasks-api.js";
import { SheetsApi } from "./sheets-api.js";
import { DocsApi } from "./docs-api.js";
import { createAccessTokenProvider } from "./google-oauth.js";
import { linkedAccounts, resolveAccounts } from "./accounts.js";
import { parseList } from "./util.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const linked = linkedAccounts(ctx.props as UserProps | undefined);
    const accounts = resolveAccounts(linked, parseList(env.ALLOWED_EMAIL), env.TASKS_ACCOUNT);
    if (!accounts.tasks) {
      return Response.json({ error: "No authorization found. Reconnect the connector." }, { status: 401 });
    }

    // Stateless, so there's no standalone SSE stream to offer. Per the spec, answer GET with 405;
    // otherwise the stream closes immediately and clients reconnect in a loop.
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    const server = new McpServer({ name: "gtasks-mcp", version: "1.1.0" });

    // Workers are short-lived, so a Google access token is minted per request. Each provider
    // caches its token, so several tool calls in one request cost one refresh per account used.
    const tokens = Object.fromEntries(
      accounts.files.map((email) => [
        email,
        createAccessTokenProvider({
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          refreshToken: linked[email]!,
        }),
      ]),
    );
    const fileAccounts = accounts.files.map((email) => tokens[email]!);
    registerTaskTools(server, new TasksApi([tokens[accounts.tasks]!]));
    registerSheetsTools(server, new SheetsApi(fileAccounts), env.TIME_ZONE || "America/New_York");
    registerDocsTools(server, new DocsApi(fileAccounts));

    // Stateless: no session IDs, each request is complete on its own, JSON responses (no SSE).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    ctx.waitUntil(server.close());
    return response;
  },
};
