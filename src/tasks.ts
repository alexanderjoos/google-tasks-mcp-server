import { tasks as tasksApi, type tasks_v1 } from "@googleapis/tasks";
import { loadAuthorizedClient } from "./auth.js";

let cached: Promise<tasks_v1.Tasks> | null = null;

/**
 * Google Tasks API クライアントを返す。
 *
 * 初回呼び出し時に認証情報を読む（遅延初期化）。
 * サーバー起動時ではなくツール実行時に認証エラーを出すことで、
 * 未認証でもサーバー自体は起動し、クライアント側に理由が伝わるようにする。
 */
export function getTasksClient(): Promise<tasks_v1.Tasks> {
  cached ??= loadAuthorizedClient()
    .then((auth) => tasksApi({ version: "v1", auth }))
    .catch((error: unknown) => {
      // 失敗した Promise をキャッシュすると認証後も回復しないため破棄する
      cached = null;
      throw error;
    });
  return cached;
}
