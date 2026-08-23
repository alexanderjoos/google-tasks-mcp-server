import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Worker に渡される環境。wrangler.jsonc の vars / secrets / KV と対応する。 */
export interface Env {
  /** OAuthProvider がクライアント登録・付与情報を保管する KV */
  OAUTH_KV: KVNamespace;
  /** OAuthProvider が注入するヘルパー */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Google OAuth クライアント（ウェブアプリ型）の ID */
  GOOGLE_CLIENT_ID: string;
  /** 同シークレット。`wrangler secret put` で設定する */
  GOOGLE_CLIENT_SECRET: string;
  /** 利用を許可する Google アカウント。ここに一致しない相手は認可しない */
  ALLOWED_EMAIL: string;
}

/** 認可完了時に暗号化して保存し、MCP ハンドラ側で受け取る値。 */
export interface UserProps {
  email: string;
  googleRefreshToken: string;
}
