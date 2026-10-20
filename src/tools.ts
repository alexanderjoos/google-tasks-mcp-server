import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TasksApi, Task } from "./tasks-api.js";
import { compactTask, compactTaskList, ok, fail, run } from "./format.js";
import { nextDay, normalizeDue } from "./util.js";

/** Upper bound on tasks returned by list_tasks across pages, to keep responses small. */
const MAX_LIST_RESULTS = 300;

const listIdArg = z
  .string()
  .default("@default")
  .describe("Task list ID. Defaults to '@default' (the main 'My Tasks' list). Get other IDs from list_task_lists.");

const taskIdArg = z.string().min(1).describe("Task ID, from list_tasks or create_task.");

const dueArg = z
  .string()
  .describe(
    "Due date as YYYY-MM-DD, in the user's local calendar (e.g. '2026-10-21' for tomorrow). " +
      "Google Tasks stores the date only; any time of day is ignored.",
  );

export function registerTaskTools(server: McpServer, api: TasksApi): void {
  server.registerTool(
    "list_task_lists",
    {
      title: "List task lists",
      description: "List the user's Google Tasks lists. Use this to find a list_id other than the default list.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.listTaskLists({ maxResults: 100 });
        return ok({ lists: (data.items ?? []).map(compactTaskList) });
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List tasks in a task list, open tasks only by default. Optional due-date filters are inclusive. " +
        "Returns id, title, notes, due (YYYY-MM-DD), status for each task.",
      inputSchema: {
        list_id: listIdArg,
        show_completed: z.boolean().default(false).describe("Include completed tasks. Default false."),
        due_after: z.string().optional().describe("Only tasks due on or after this date (YYYY-MM-DD)."),
        due_before: z.string().optional().describe("Only tasks due on or before this date (YYYY-MM-DD). For 'due today or overdue', pass today's date."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ list_id, show_completed, due_after, due_before }) =>
      run(async () => {
        const query = {
          maxResults: 100,
          showCompleted: show_completed,
          // Tasks completed in other Google clients are "hidden" and only returned with showHidden.
          showHidden: show_completed,
          dueMin: due_after === undefined ? undefined : normalizeDue(due_after),
          // dueMax is exclusive at day granularity, so pass the next day to include due_before itself.
          dueMax: due_before === undefined ? undefined : nextDay(due_before),
        };
        const tasks: Task[] = [];
        let pageToken: string | undefined;
        do {
          const page = await api.listTasks(list_id, { ...query, pageToken });
          tasks.push(...(page.items ?? []));
          pageToken = page.nextPageToken;
        } while (pageToken && tasks.length < MAX_LIST_RESULTS);
        return ok({
          tasks: tasks.slice(0, MAX_LIST_RESULTS).map(compactTask),
          ...(pageToken ? { truncated: true } : {}),
        });
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Get one task by ID.",
      inputSchema: { task_id: taskIdArg, list_id: listIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ task_id, list_id }) => run(async () => ok(compactTask(await api.getTask(list_id, task_id)))),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description:
        "Create a task in Google Tasks (shows in Google Calendar's Tasks panel). " +
        "Due dates are date-only; for a specific time, create a calendar event instead.",
      inputSchema: {
        title: z.string().min(1).describe("Task title."),
        notes: z.string().optional().describe("Optional details."),
        due_date: dueArg.optional(),
        list_id: listIdArg,
        parent_id: z.string().optional().describe("Optional parent task ID, to create this as a subtask."),
      },
    },
    async ({ title, notes, due_date, list_id, parent_id }) =>
      run(async () => {
        const task = await api.insertTask(
          list_id,
          { title, notes, due: due_date === undefined ? undefined : normalizeDue(due_date) },
          { parent: parent_id },
        );
        return ok(compactTask(task));
      }),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Change a task's title, notes or due date. Only fields you pass are changed. " +
        "Pass notes as '' to clear them, or due_date as null to remove the due date. To mark done, use complete_task.",
      inputSchema: {
        task_id: taskIdArg,
        list_id: listIdArg,
        title: z.string().min(1).optional().describe("New title."),
        notes: z.string().optional().describe("New notes. '' clears them."),
        due_date: dueArg.nullable().optional(),
      },
    },
    async ({ task_id, list_id, title, notes, due_date }) =>
      run(async () => {
        const body: Omit<Partial<Task>, "due"> & { due?: string | null } = {};
        if (title !== undefined) body.title = title;
        if (notes !== undefined) body.notes = notes;
        if (due_date === null) body.due = null;
        else if (due_date !== undefined) body.due = normalizeDue(due_date);
        if (Object.keys(body).length === 0) return fail("Nothing to update. Pass title, notes or due_date.");
        return ok(compactTask(await api.patchTask(list_id, task_id, body as Partial<Task>)));
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete task",
      description: "Mark a task done. Pass completed: false to reopen it.",
      inputSchema: {
        task_id: taskIdArg,
        list_id: listIdArg,
        completed: z.boolean().default(true).describe("true marks done (default), false reopens."),
      },
    },
    async ({ task_id, list_id, completed }) =>
      run(async () => {
        // Reopening also requires clearing the completion timestamp.
        const body = completed ? { status: "completed" as const } : { status: "needsAction" as const, completed: null };
        return ok(compactTask(await api.patchTask(list_id, task_id, body)));
      }),
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description: "Permanently delete a task. Can't be undone. Prefer complete_task when the user means 'done'.",
      inputSchema: { task_id: taskIdArg, list_id: listIdArg },
      annotations: { destructiveHint: true },
    },
    async ({ task_id, list_id }) =>
      run(async () => {
        await api.deleteTask(list_id, task_id);
        return ok({ deleted: task_id });
      }),
  );
}
