import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Worker environment. Matches the vars, secrets and KV binding in wrangler.jsonc. */
export interface Env {
  /** KV store used by OAuthProvider for clients/grants/tokens, and by us for pending authorizations. */
  OAUTH_KV: KVNamespace;
  /** Helpers injected by OAuthProvider. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Google OAuth client ID (Web application type). Secret. */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth client secret. Secret. */
  GOOGLE_CLIENT_SECRET: string;
  /** The only Google account allowed to authorize. Secret, to keep it out of the repo. */
  ALLOWED_EMAIL: string;
  /** Comma-separated hostnames that MCP clients may redirect to. Var. */
  ALLOWED_REDIRECT_HOSTS: string;
}

/** Stored encrypted in the grant at authorization time and decrypted into ctx.props on /mcp. */
export interface UserProps {
  email: string;
  googleRefreshToken: string;
}
