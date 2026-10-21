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
  /** Comma-separated Google accounts allowed to authorize, in the order Sheets/Docs try them. Secret, to keep it out of the repo. */
  ALLOWED_EMAIL: string;
  /** Optional: the linked account Google Tasks uses. Defaults to the first in ALLOWED_EMAIL. Secret. */
  TASKS_ACCOUNT?: string;
  /** Comma-separated hostnames that MCP clients may redirect to. Var. */
  ALLOWED_REDIRECT_HOSTS: string;
  /** IANA time zone for interpreting due dates, e.g. "America/New_York". Var. */
  TIME_ZONE: string;
}

/** Stored encrypted in the grant at authorization time and decrypted into ctx.props on /mcp. */
export interface UserProps {
  /** Linked Google accounts, email → refresh token. */
  accounts?: Record<string, string>;
  /** Single-account grants from before multi-account support. */
  email?: string;
  googleRefreshToken?: string;
}
