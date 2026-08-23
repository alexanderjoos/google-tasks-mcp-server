/**
 * Cloudflare Workers 版のエントリポイント。
 *
 * OAuthProvider が OAuth 2.1 認可サーバーの一式
 * （/.well-known メタデータ、/authorize、/token、/register）を提供し、
 * 検証を通ったリクエストだけを /mcp のハンドラに渡す。
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import googleHandler from "./google-handler.js";
import mcpHandler from "./mcp-handler.js";

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: googleHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // Claude は動的クライアント登録（DCR）で接続してくるため必須
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["tasks"],
});
