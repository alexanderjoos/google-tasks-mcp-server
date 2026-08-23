/**
 * OAuth の利用者向け画面と Google への橋渡し。
 *
 * Claude からは「この MCP サーバー自身が認可サーバー」に見える。
 * 実際の本人確認は Google に委譲し、得た Google のリフレッシュトークンは
 * 暗号化された props として保管する。Claude 側には渡さない。
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env, UserProps } from "./env.js";
import {
  buildAuthUrl,
  exchangeCode,
  fetchUserEmail,
  EMAIL_SCOPE,
  TASKS_SCOPE,
} from "../src/shared/google-oauth.js";

/** Google 往復の間、元の認可リクエストを預けておく KV キーの接頭辞。 */
const STATE_PREFIX = "gtasks:authstate:";
const STATE_TTL_SECONDS = 600;

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Google Tasks MCP</title>` +
      `<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;line-height:1.7}` +
      `code{background:#f4f4f5;padding:.15em .4em;border-radius:.25em}</style>${body}`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).toString();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---------- 認可の開始 ----------
    if (url.pathname === "/authorize") {
      const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      if (!(await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId))) {
        return html("<h1>不明なクライアント</h1><p>登録されていないクライアントからの要求です。</p>", 400);
      }

      // 元の認可リクエストは KV に預け、Google には推測不能な state だけを渡す
      const state = crypto.randomUUID();
      await env.OAUTH_KV.put(STATE_PREFIX + state, JSON.stringify(authRequest), {
        expirationTtl: STATE_TTL_SECONDS,
      });

      return Response.redirect(
        buildAuthUrl({
          clientId: env.GOOGLE_CLIENT_ID,
          redirectUri: callbackUrl(request),
          state,
          scopes: [TASKS_SCOPE, EMAIL_SCOPE],
          loginHint: env.ALLOWED_EMAIL,
        }),
        302,
      );
    }

    // ---------- Google からの復帰 ----------
    if (url.pathname === "/callback") {
      const error = url.searchParams.get("error");
      if (error) return html(`<h1>認証が中断されました</h1><p>Google から <code>${error}</code> が返りました。</p>`, 400);

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!state || !code) return html("<h1>不正な応答</h1><p>state または code がありません。</p>", 400);

      const stored = await env.OAUTH_KV.get(STATE_PREFIX + state);
      if (!stored) {
        return html("<h1>セッションが期限切れです</h1><p>時間をおきすぎたか、既に使用済みです。最初からやり直してください。</p>", 400);
      }
      // 使い捨てにして再利用を防ぐ
      await env.OAUTH_KV.delete(STATE_PREFIX + state);
      const authRequest = JSON.parse(stored) as AuthRequest;

      const token = await exchangeCode({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        code,
        redirectUri: callbackUrl(request),
      });
      if (!token.refresh_token) {
        return html(
          "<h1>リフレッシュトークンが取得できませんでした</h1>" +
            "<p><a href=\"https://myaccount.google.com/permissions\">Google のアカウント権限</a>から本アプリのアクセスを削除し、もう一度お試しください。</p>",
          400,
        );
      }

      // 利用者を 1 人に限定する。公開エンドポイントなので必須。
      const email = await fetchUserEmail(token.access_token);
      if (email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
        return html(`<h1>利用が許可されていません</h1><p><code>${email}</code> はこのサーバーの許可アカウントではありません。</p>`, 403);
      }

      const props: UserProps = { email, googleRefreshToken: token.refresh_token };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: email,
        metadata: { label: email },
        scope: authRequest.scope,
        props,
        // 再認可時に古い付与を残さない
        revokeExistingGrants: true,
      });
      return Response.redirect(redirectTo, 302);
    }

    // ---------- 案内ページ ----------
    if (url.pathname === "/") {
      return html(
        "<h1>Google Tasks MCP サーバー</h1>" +
          "<p>Claude のカスタムコネクタとして登録して使います。</p>" +
          `<p>MCP エンドポイント: <code>${new URL("/mcp", request.url).toString()}</code></p>` +
          "<p>認可されるのは設定された 1 アカウントのみです。</p>",
      );
    }

    return html("<h1>404</h1>", 404);
  },
};
