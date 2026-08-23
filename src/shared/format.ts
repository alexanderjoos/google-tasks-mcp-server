import type { Task, TaskList } from "./tasks-api.js";
import { TasksApiError } from "./tasks-api.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * API レスポンスから kind / etag / selfLink を落とす。
 * LLM の判断に使われない項目で、そのまま返すとコンテキストを圧迫するため。
 */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const { kind, etag, selfLink, ...rest } = value;
  return rest as Partial<T>;
}

export function compactTask(task: Task): Partial<Task> {
  return compact(task as Record<string, unknown>) as Partial<Task>;
}

export function compactTaskList(list: TaskList): Partial<TaskList> {
  return compact(list as Record<string, unknown>) as Partial<TaskList>;
}

/** 成功結果を JSON テキストとして返す。 */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** 失敗結果。例外を投げるのではなく isError で返し、LLM が回復できるようにする。 */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Google API のエラーを読めるメッセージに変換する。 */
export function describeError(error: unknown): string {
  if (error instanceof TasksApiError) {
    if (error.status === 401 || error.status === 403) {
      return `Google API の認証・権限エラー (${error.status}): ${error.message}\n再認証するか、GCP で Tasks API が有効か確認してください。`;
    }
    if (error.status === 404) {
      return `対象が見つかりません (404): ${error.message}\ntasklist / task の ID を確認してください。`;
    }
    return `Google API エラー (${error.status}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
