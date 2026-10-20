/**
 * The authenticated MCP endpoint (/mcp).
 *
 * OAuthProvider calls this only after validating the bearer token, and passes the decrypted
 * grant props (the Google refresh token) in ctx.props.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env, UserProps } from "./env.js";
import { registerTools } from "./tools.js";
import { TasksApi } from "./tasks-api.js";
import { createAccessTokenProvider } from "./google-oauth.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as UserProps | undefined;
    if (!props?.googleRefreshToken) {
      return Response.json({ error: "No authorization found. Reconnect the connector." }, { status: 401 });
    }

    const server = new McpServer({ name: "gtasks-mcp", version: "1.0.0" });

    // Workers are short-lived, so a Google access token is minted per request. The provider
    // caches it, so several tool calls in one request still cost one refresh round trip.
    const api = new TasksApi(
      createAccessTokenProvider({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        refreshToken: props.googleRefreshToken,
      }),
    );
    registerTools(server, api);

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
