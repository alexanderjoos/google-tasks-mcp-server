/**
 * Google Tasks REST API の薄いクライアント。
 *
 * fetch のみを使い Node 固有 API に依存しないため、
 * stdio 版（Node）と Cloudflare Workers 版の両方で共有できる。
 * （@googleapis/tasks は Node 依存で Workers では動かない）
 */

const BASE = "https://tasks.googleapis.com/tasks/v1";

export interface Task {
  id?: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: "needsAction" | "completed";
  completed?: string | null;
  parent?: string;
  position?: string;
  updated?: string;
  deleted?: boolean;
  hidden?: boolean;
  webViewLink?: string;
}

export interface TaskList {
  id?: string;
  title?: string;
  updated?: string;
}

export interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

/** アクセストークンを供給する。期限切れ時の更新は実装側の責務。 */
export type AccessTokenProvider = () => Promise<string>;

/** Google API がエラーを返したときに投げる。HTTP ステータスを保持する。 */
export class TasksApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TasksApiError";
  }
}

export class TasksApi {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(BASE + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getAccessToken()}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    if (!response.ok) {
      const text = await response.text();
      let detail = text;
      try {
        detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        // JSON でなければ本文をそのまま使う
      }
      throw new TasksApiError(response.status, detail);
    }

    // DELETE や clear は 204 で本文が空
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---------- タスクリスト ----------

  listTaskLists(query: { maxResults?: number; pageToken?: string } = {}): Promise<ListResponse<TaskList>> {
    return this.request("GET", "/users/@me/lists", { query });
  }

  getTaskList(tasklist: string): Promise<TaskList> {
    return this.request("GET", `/users/@me/lists/${encodeURIComponent(tasklist)}`);
  }

  createTaskList(title: string): Promise<TaskList> {
    return this.request("POST", "/users/@me/lists", { body: { title } });
  }

  patchTaskList(tasklist: string, body: Partial<TaskList>): Promise<TaskList> {
    return this.request("PATCH", `/users/@me/lists/${encodeURIComponent(tasklist)}`, { body });
  }

  deleteTaskList(tasklist: string): Promise<void> {
    return this.request("DELETE", `/users/@me/lists/${encodeURIComponent(tasklist)}`);
  }

  // ---------- タスク ----------

  listTasks(tasklist: string, query: Record<string, unknown> = {}): Promise<ListResponse<Task>> {
    return this.request("GET", `/lists/${encodeURIComponent(tasklist)}/tasks`, { query });
  }

  getTask(tasklist: string, task: string): Promise<Task> {
    return this.request("GET", `/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(task)}`);
  }

  insertTask(
    tasklist: string,
    body: Partial<Task>,
    query: { parent?: string; previous?: string } = {},
  ): Promise<Task> {
    return this.request("POST", `/lists/${encodeURIComponent(tasklist)}/tasks`, { body, query });
  }

  patchTask(tasklist: string, task: string, body: Partial<Task>): Promise<Task> {
    return this.request("PATCH", `/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(task)}`, {
      body,
    });
  }

  deleteTask(tasklist: string, task: string): Promise<void> {
    return this.request("DELETE", `/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(task)}`);
  }

  moveTask(
    tasklist: string,
    task: string,
    query: { parent?: string; previous?: string; destinationTasklist?: string } = {},
  ): Promise<Task> {
    return this.request("POST", `/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(task)}/move`, {
      query,
    });
  }

  clearCompleted(tasklist: string): Promise<void> {
    return this.request("POST", `/lists/${encodeURIComponent(tasklist)}/clear`);
  }
}
