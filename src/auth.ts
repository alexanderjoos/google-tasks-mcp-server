/**
 * stdio 版（Node）の認証。
 * client_secret とトークンをローカルファイルから読み、Tasks API クライアントを組み立てる。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clientSecretPath, tokenPath } from "./config.js";
import { createAccessTokenProvider, type TokenResponse } from "./shared/google-oauth.js";
import { TasksApi } from "./shared/tasks-api.js";

export interface ClientSecret {
  clientId: string;
  clientSecret: string;
}

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  scope?: string;
  expiry_date?: number;
}

/**
 * client_secret_*.json を読む。
 * デスクトップアプリ型は `installed`、ウェブアプリ型は `web` キーに情報が入る。
 */
export async function readClientSecret(): Promise<ClientSecret> {
  const path = clientSecretPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `client_secret ファイルを読めません: ${path}\n` +
        "GCP コンソール → APIs & Services → Credentials からダウンロードしたか、パスが正しいか確認してください。",
    );
  }

  const parsed = JSON.parse(raw) as {
    installed?: { client_id?: string; client_secret?: string };
    web?: { client_id?: string; client_secret?: string };
  };
  const key = parsed.installed ?? parsed.web;
  if (!key?.client_id || !key.client_secret) {
    throw new Error(
      `client_secret ファイルの形式が想定と違います: ${path}\n` +
        "OAuth 2.0 クライアント ID（デスクトップアプリ）の JSON をそのまま指定してください。",
    );
  }
  return { clientId: key.client_id, clientSecret: key.client_secret };
}

/** 保存済みトークンを読む。未認証なら null。 */
export async function readSavedToken(): Promise<StoredToken | null> {
  try {
    return JSON.parse(await readFile(tokenPath(), "utf8")) as StoredToken;
  } catch {
    return null;
  }
}

/** トークンを本人のみ読める権限（0600）で保存する。 */
export async function saveToken(token: StoredToken): Promise<void> {
  const path = tokenPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/** 保存済みトークンから Tasks API クライアントを組み立てる。 */
export async function createTasksApi(): Promise<TasksApi> {
  const { clientId, clientSecret } = await readClientSecret();
  const saved = await readSavedToken();
  if (!saved?.refresh_token) {
    throw new Error(
      `未認証です（トークン: ${tokenPath()}）。\n` +
        "プロジェクトディレクトリで `npm run auth` を実行してブラウザ認証を済ませてください。",
    );
  }

  const getAccessToken = createAccessTokenProvider({
    clientId,
    clientSecret,
    refreshToken: saved.refresh_token,
    // リフレッシュ時は refresh_token が含まれないことがあるため、既存の値とマージする
    onRefresh: (token: TokenResponse) =>
      saveToken({
        ...saved,
        access_token: token.access_token,
        expiry_date: Date.now() + token.expires_in * 1000,
      }).catch((error: unknown) => {
        console.error("[google-tasks-mcp] トークンの保存に失敗しました:", error);
      }),
  });

  return new TasksApi(getAccessToken);
}
