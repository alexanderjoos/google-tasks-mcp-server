/**
 * Google OAuth 2.0 の最小実装。
 * fetch のみを使うため Node / Cloudflare Workers の両方で動く。
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

/** このサーバーが要求する OAuth スコープ。Google Tasks の読み書きのみ。 */
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
/** 利用者を 1 人に限定するためにメールアドレスを得るスコープ。 */
export const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  codeChallenge?: string;
  loginHint?: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  // リフレッシュトークンを確実に受け取るため、毎回同意画面を出す
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google のトークンエンドポイントがエラーを返しました (${response.status}): ${text}`);
  }
  return JSON.parse(text) as TokenResponse;
}

/** 認可コードをトークンに交換する。 */
export function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string;
}): Promise<TokenResponse> {
  return postToken({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    ...(params.codeVerifier ? { code_verifier: params.codeVerifier } : {}),
  });
}

/** リフレッシュトークンからアクセストークンを取り直す。 */
export function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  return postToken({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });
}

/** アクセストークンの持ち主のメールアドレスを取得する。利用者の限定に使う。 */
export async function fetchUserEmail(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`ユーザー情報の取得に失敗しました (${response.status})`);
  }
  const { email } = (await response.json()) as { email?: string };
  if (!email) throw new Error("ユーザー情報にメールアドレスが含まれていません。");
  return email;
}

/**
 * アクセストークンをメモリ上でキャッシュしつつ供給する。
 * 有効期限の 1 分前に取り直すことで、境界での 401 を避ける。
 */
export function createAccessTokenProvider(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  onRefresh?: (token: TokenResponse) => void | Promise<void>;
}): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const token = await refreshAccessToken(params);
    cached = { token: token.access_token, expiresAt: Date.now() + (token.expires_in - 60) * 1000 };
    await params.onRefresh?.(token);
    return cached.token;
  };
}
