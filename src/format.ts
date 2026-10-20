import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Task, TaskList } from "./tasks-api.js";
import { TasksApiError } from "./tasks-api.js";

/** The fields Claude needs to follow up (update/complete/delete), minus API envelope noise. */
export function compactTask(task: Task) {
  return {
    id: task.id,
    title: task.title,
    ...(task.notes ? { notes: task.notes } : {}),
    // Google stores date only; return YYYY-MM-DD so it isn't mistaken for a time.
    ...(task.due ? { due: task.due.slice(0, 10) } : {}),
    status: task.status,
    ...(task.completed ? { completed: task.completed } : {}),
    ...(task.parent ? { parent: task.parent } : {}),
  };
}

export function compactTaskList(list: TaskList) {
  return { id: list.id, title: list.title };
}

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Return errors as results (isError) rather than throwing, so the model can recover. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function describeError(error: unknown): string {
  if (error instanceof TasksApiError) {
    if (error.status === 401) {
      return `Google rejected the credentials (401): ${error.message}. Reconnect the connector in Claude to sign in again.`;
    }
    if (error.status === 403) {
      return `Permission denied (403): ${error.message}. Check that the Google Tasks API is enabled in the Google Cloud project.`;
    }
    if (error.status === 404) {
      return `Not found (404): ${error.message}. Check the task_id / list_id (use list_tasks or list_task_lists).`;
    }
    return `Google Tasks API error (${error.status}): ${error.message}`;
  }
  if (error instanceof Error && error.message.startsWith("Google token endpoint returned 400 (invalid_grant)")) {
    return "The saved Google sign-in has expired or was revoked. Reconnect the connector in Claude.";
  }
  return error instanceof Error ? error.message : String(error);
}
