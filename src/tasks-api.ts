/**
 * Thin client for the Google Tasks REST API.
 * Reference: https://developers.google.com/workspace/tasks/reference/rest
 */

import { createGoogleClient, type AccessTokenProvider } from "./google-api.js";

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

export class TasksApi {
  private readonly request: ReturnType<typeof createGoogleClient>;

  /** Accounts to try in order; see createGoogleClient. */
  constructor(accounts: AccessTokenProvider[]) {
    this.request = createGoogleClient("Google Tasks", BASE, accounts);
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
