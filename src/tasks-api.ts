/**
 * Thin client for the Google Tasks REST API. fetch only (googleapis packages don't run on Workers).
 * Reference: https://developers.google.com/workspace/tasks/reference/rest
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

export type AccessTokenProvider = () => Promise<string>;

/** Thrown when Google returns a non-2xx response. Keeps the HTTP status. */
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
        // not JSON, use the raw body
      }
      throw new TasksApiError(response.status, detail);
    }

    // DELETE returns 204 with an empty body.
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  listTaskLists(query: { maxResults?: number; pageToken?: string } = {}): Promise<ListResponse<TaskList>> {
    return this.request("GET", "/users/@me/lists", { query });
  }

  listTasks(tasklist: string, query: Record<string, unknown> = {}): Promise<ListResponse<Task>> {
    return this.request("GET", `/lists/${encodeURIComponent(tasklist)}/tasks`, { query });
  }

  getTask(tasklist: string, task: string): Promise<Task> {
    return this.request("GET", `/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(task)}`);
  }

  insertTask(tasklist: string, body: Partial<Task>, query: { parent?: string } = {}): Promise<Task> {
    return this.request("POST", `/lists/${encodeURIComponent(tasklist)}/tasks`, { body, query });
  }

  /** PATCH, not PUT: PUT would wipe any field we don't send. */
  patchTask(tasklist: string, task: string, body: Partial<Task>): Promise<Task> {
    return this.request("PATCH", `/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(task)}`, { body });
  }

  deleteTask(tasklist: string, task: string): Promise<void> {
    return this.request("DELETE", `/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(task)}`);
  }
}
