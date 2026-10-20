/**
 * Minimal Google OAuth 2.0 client. Uses only fetch, so it runs on Workers.
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/** Read/write access to Google Tasks, and nothing else. */
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
/** Needed to read the account's email for the single-user allowlist. */
export const IDENTITY_SCOPES = ["openid", "email"];

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
  loginHint?: string;
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...IDENTITY_SCOPES, TASKS_SCOPE].join(" "));
  url.searchParams.set("state", params.state);
  // Always show consent so Google always returns a refresh token.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
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
    // Don't echo the body: it can contain token material on partial failures.
    let code = "";
    try {
      code = (JSON.parse(text) as { error?: string }).error ?? "";
    } catch {
      // not JSON
    }
    throw new Error(`Google token endpoint returned ${response.status}${code ? ` (${code})` : ""}`);
  }
  return JSON.parse(text) as TokenResponse;
}

/** Exchange an authorization code for tokens. */
export function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  return postToken({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  });
}

/** Get a fresh access token from a refresh token. */
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

/** Look up the signed-in account's email and whether Google has verified it. */
export async function fetchUserEmail(accessToken: string): Promise<{ email: string; verified: boolean }> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Failed to fetch Google user info (${response.status})`);
  const info = (await response.json()) as { email?: string; email_verified?: boolean };
  if (!info.email) throw new Error("Google user info did not include an email address.");
  return { email: info.email, verified: info.email_verified === true };
}

/**
 * Returns a function that supplies a valid access token, refreshing via the refresh token.
 * Caches in memory and refreshes one minute before expiry to avoid 401s at the boundary.
 */
export function createAccessTokenProvider(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    // Coalesce concurrent refreshes within one request.
    inflight ??= refreshAccessToken(params)
      .then((token) => {
        cached = { token: token.access_token, expiresAt: Date.now() + (token.expires_in - 60) * 1000 };
        return cached.token;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
