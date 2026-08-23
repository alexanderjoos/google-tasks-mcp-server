import type { tasks_v1 } from "@googleapis/tasks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * API レスポンスから kind / etag / selfLink を落とす。
 * LLM の判断に使われない項目で、そのまま返すとコンテキストを圧迫するため。
 */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const { kind, etag, selfLink, ...rest } = value;
  return rest as Partial<T>;
}

export function compactTask(task: tasks_v1.Schema$Task): Partial<tasks_v1.Schema$Task> {
  return compact(task as Record<string, unknown>) as Partial<tasks_v1.Schema$Task>;
}

export function compactTaskList(list: tasks_v1.Schema$TaskList): Partial<tasks_v1.Schema$TaskList> {
  return compact(list as Record<string, unknown>) as Partial<tasks_v1.Schema$TaskList>;
}

/** 成功結果を JSON テキストとして返す。 */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** 失敗結果。例外を投げるのではなく isError で返し、LLM が回復できるようにする。 */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Google API のエラーを読めるメッセージに変換する。
 * 生の GaxiosError はスタックとリクエスト全体を含み、そのままでは扱いにくい。
 */
export function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const gaxios = error as {
      status?: number;
      response?: { status?: number; data?: { error?: { message?: string; errors?: unknown } } };
      message?: string;
    };
    const status = gaxios.status ?? gaxios.response?.status;
    const detail = gaxios.response?.data?.error?.message ?? gaxios.message;
    if (status === 401 || status === 403) {
      return `Google API の認証・権限エラー (${status}): ${detail ?? "詳細なし"}\n\`npm run auth\` で再認証するか、GCP で Tasks API が有効か確認してください。`;
    }
    if (status === 404) {
      return `対象が見つかりません (404): ${detail ?? "詳細なし"}\ntasklist / task の ID を確認してください。`;
    }
    if (status !== undefined) return `Google API エラー (${status}): ${detail ?? "詳細なし"}`;
    if (detail) return detail;
  }
  return String(error);
}
