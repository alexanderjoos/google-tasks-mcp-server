import { homedir } from "node:os";
import { join } from "node:path";

/** このサーバーが要求する OAuth スコープ。Google Tasks の読み書きのみ。 */
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";

/** `~/` 始まりのパスをホームディレクトリに展開する。 */
function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * GCP からダウンロードした client_secret_*.json のパス。
 * 環境変数 GOOGLE_TASKS_CLIENT_SECRET_PATH で指定する（必須）。
 */
export function clientSecretPath(): string {
  const path = process.env.GOOGLE_TASKS_CLIENT_SECRET_PATH;
  if (!path) {
    throw new Error(
      "環境変数 GOOGLE_TASKS_CLIENT_SECRET_PATH が未設定です。" +
        "GCP からダウンロードした client_secret_*.json のパスを指定してください。",
    );
  }
  return expandHome(path);
}

/**
 * 認証済みトークンの保存先。
 * 環境変数 GOOGLE_TASKS_TOKEN_PATH で上書きできる。
 */
export function tokenPath(): string {
  const override = process.env.GOOGLE_TASKS_TOKEN_PATH;
  if (override) return expandHome(override);
  return join(homedir(), ".config", "google-tasks-mcp-server", "token.json");
}
