import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Task, TaskList } from "./tasks-api.js";
import { GoogleApiError } from "./google-api.js";

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

const NOT_FOUND_HINT: Record<string, string> = {
  "Google Tasks": "Check the task_id / list_id (use list_tasks or list_task_lists).",
  "Google Sheets": "Check the spreadsheet URL/ID and the tab name in the range (use sheets_get_info).",
  "Google Docs": "Check the document URL/ID.",
};

/** Run a tool handler, turning thrown errors into readable isError results. */
export async function run(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return fail(describeError(error));
  }
}

export function describeError(error: unknown): string {
  if (error instanceof GoogleApiError) {
    const { service, status, message } = error;
    if (status === 401) {
      return `Google rejected the credentials (401): ${message}. Reconnect the connector in Claude to sign in again.`;
    }
    if (status === 403 && /insufficient authentication scopes/i.test(message)) {
      return `${service} access wasn't granted when this connector was authorized. Reconnect the connector in Claude and approve all requested permissions.`;
    }
    if (status === 403 && /has not been used|is disabled/i.test(message)) {
      return `The ${service} API isn't enabled in the Google Cloud project (403): ${message}`;
    }
    if (status === 403) {
      return `Permission denied (403): ${message}. The signed-in account may not have edit access to this file.`;
    }
    if (status === 404) {
      return `Not found (404): ${message}. ${NOT_FOUND_HINT[service] ?? ""}`.trim();
    }
    return `${service} API error (${status}): ${message}`;
  }
  if (error instanceof Error && error.message.startsWith("Google token endpoint returned 400 (invalid_grant)")) {
    return "The saved Google sign-in has expired or was revoked. Reconnect the connector in Claude.";
  }
  return error instanceof Error ? error.message : String(error);
}
