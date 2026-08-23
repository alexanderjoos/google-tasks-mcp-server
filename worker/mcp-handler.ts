/**
 * 認証済みリクエストを受ける MCP エンドポイント（/mcp）。
 *
 * OAuthProvider がベアラートークンを検証したあとにだけ呼ばれ、
 * 認可時に保存した props が ctx.props に復号されて渡ってくる。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env, UserProps } from "./env.js";
import { registerTools } from "../src/shared/tools.js";
import { TasksApi } from "../src/shared/tasks-api.js";
import { createAccessTokenProvider } from "../src/shared/google-oauth.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as UserProps | undefined;
    if (!props?.googleRefreshToken) {
      return new Response(
        JSON.stringify({ error: "認可情報がありません。コネクタを接続し直してください。" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const server = new McpServer({ name: "google-tasks-mcp-server", version: "0.2.0" });

    // Worker のインスタンスは短命なので、アクセストークンはリクエストごとに取り直す。
    // createAccessTokenProvider がインスタンス内ではキャッシュするため、
    // 1 リクエストで複数ツールを呼んでも Google への往復は 1 回で済む。
    const api = new TasksApi(
      createAccessTokenProvider({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        refreshToken: props.googleRefreshToken,
      }),
    );
    registerTools(server, async () => api);

    // ステートレス運用。Worker はリクエスト間で状態を保てないため、
    // セッション ID を発行せず 1 リクエストで完結させる。
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
