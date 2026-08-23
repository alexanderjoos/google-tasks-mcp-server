/**
 * 初回認証用の CLI（`npm run auth`）。
 *
 * MCP サーバー本体ではなく、あえて独立したコマンドとして認証を行う。
 * MCP サーバーは stdio を JSON-RPC で占有しており、
 * ブラウザ起動や進捗ログの出力が混ざるとプロトコルが壊れるため。
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { readClientSecret, saveToken } from "./auth.js";
import { tokenPath } from "./config.js";
import { buildAuthUrl, exchangeCode, TASKS_SCOPE } from "./shared/google-oauth.js";

/** OS ごとの既定ブラウザで URL を開く。失敗しても致命的ではない。 */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
  } catch {
    // 開けなくても URL を表示済みなので手動で開いてもらえばよい
  }
}

/**
 * ループバック（127.0.0.1 の一時ポート）で認可コードを受け取る。
 * デスクトップアプリ型の OAuth クライアントは任意のループバックポートを
 * リダイレクト先にできるため、GCP 側でのリダイレクト URI 登録は不要。
 */
async function authorize(): Promise<void> {
  const { clientId, clientSecret } = await readClientSecret();
  const state = randomBytes(16).toString("hex");

  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }

      const respond = (message: string) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><p>${message}</p>`);
      };
      const abort = (userMessage: string, error: Error) => {
        respond(userMessage);
        server.close();
        reject(error);
      };

      const errorParam = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (errorParam) {
        abort("認証が拒否されました。ターミナルに戻ってください。", new Error(`認証が拒否されました: ${errorParam}`));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        abort("state が一致しません。認証を中止しました。", new Error("state が一致しません（CSRF の疑い）。もう一度やり直してください。"));
        return;
      }
      if (!code) {
        abort("認可コードが取得できませんでした。", new Error("認可コードが取得できませんでした。"));
        return;
      }

      respond("認証が完了しました。ターミナルに戻ってください。");
      const { port } = server.address() as AddressInfo;

      exchangeCode({
        clientId,
        clientSecret,
        code,
        redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
      })
        .then(async (token) => {
          if (!token.refresh_token) {
            throw new Error(
              "リフレッシュトークンが返りませんでした。" +
                "https://myaccount.google.com/permissions でこのアプリのアクセス権を削除してから、もう一度実行してください。",
            );
          }
          await saveToken({
            refresh_token: token.refresh_token,
            access_token: token.access_token,
            scope: token.scope,
            expiry_date: Date.now() + token.expires_in * 1000,
          });
          console.log(`認証が完了しました。トークンを保存しました: ${tokenPath()}`);
          resolve();
        })
        .catch(reject)
        .finally(() => server.close());
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const authUrl = buildAuthUrl({
        clientId,
        redirectUri: `http://127.0.0.1:${port}/oauth2callback`,
        state,
        scopes: [TASKS_SCOPE],
      });
      console.log("ブラウザで以下の URL を開いて認証してください:\n");
      console.log(authUrl + "\n");
      openBrowser(authUrl);
    });
  });
}

authorize().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
