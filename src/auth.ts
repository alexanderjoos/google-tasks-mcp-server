import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { clientSecretPath, tokenPath } from "./config.js";

export interface ClientSecret {
  clientId: string;
  clientSecret: string;
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
export async function readSavedToken(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(tokenPath(), "utf8")) as Credentials;
  } catch {
    return null;
  }
}

/** トークンを本人のみ読める権限（0600）で保存する。 */
export async function saveToken(credentials: Credentials): Promise<void> {
  const path = tokenPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}

/**
 * 保存済みトークンから認証済みクライアントを作る。
 * アクセストークンの期限切れはライブラリが自動更新するので、
 * 更新後の値を取りこぼさないよう tokens イベントで保存し直す。
 */
export async function loadAuthorizedClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await readClientSecret();
  const saved = await readSavedToken();
  if (!saved?.refresh_token) {
    throw new Error(
      `未認証です（トークン: ${tokenPath()}）。\n` +
        "プロジェクトディレクトリで `npm run auth` を実行してブラウザ認証を済ませてください。",
    );
  }

  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(saved);
  client.on("tokens", (tokens) => {
    // リフレッシュ時は refresh_token が含まれないことがあるため、既存の値とマージする。
    void saveToken({ ...saved, ...tokens }).catch((error: unknown) => {
      console.error("[google-tasks-mcp] トークンの保存に失敗しました:", error);
    });
  });
  return client;
}
