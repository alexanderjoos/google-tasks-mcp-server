import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TasksApi } from "./tasks-api.js";
import { compactTask, compactTaskList, describeError, ok, fail } from "./format.js";

/** 実行時に Tasks API クライアントを供給する。ランタイムごとに実装が異なる。 */
export type TasksApiProvider = () => Promise<TasksApi>;

/** 全ツール共通のエラー処理。API 例外を isError 付きの結果に変換する。 */
async function run(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return fail(describeError(error));
  }
}

/**
 * 期限フィルタを日付境界に正規化する。
 *
 * Google Tasks API の dueMax は「日付単位で排他的」で、
 * dueMax に当日 23:59:59 を渡しても当日期限のタスクは 1 件も返らない。
 * 当日分を含めるには翌日 0 時を渡す必要がある。
 * 直感と反するため、ここで dueMax を「指定日を含む」意味に揃える。
 */
function normalizeDueRange(dueMin?: string, dueMax?: string): { dueMin?: string; dueMax?: string } {
  const startOfDay = (value: string, addDays: number): string => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`期限の日時として解釈できません: ${value}（RFC 3339 形式で指定してください）`);
    }
    return new Date(
      Date.UTC(
        parsed.getUTCFullYear(),
        parsed.getUTCMonth(),
        parsed.getUTCDate() + addDays,
      ),
    ).toISOString();
  };
  return {
    dueMin: dueMin === undefined ? undefined : startOfDay(dueMin, 0),
    // 指定日を含めるため翌日 0 時に繰り上げる
    dueMax: dueMax === undefined ? undefined : startOfDay(dueMax, 1),
  };
}

const tasklistArg = z
  .string()
  .default("@default")
  .describe("タスクリストの ID。既定のリストは '@default'。ID は list-tasklists で取得できる。");

const taskArg = z.string().describe("タスクの ID。list-tasks で取得できる。");

const dueDescription =
  "期限。RFC 3339 形式（例: 2026-08-30T00:00:00.000Z）。" +
  "Google Tasks は日付部分のみ保持し、時刻は無視される。";

export function registerTools(server: McpServer, getApi: TasksApiProvider): void {
  // ---------- タスクリスト ----------

  server.registerTool(
    "list-tasklists",
    {
      title: "タスクリスト一覧",
      description: "認証中のアカウントが持つタスクリストを一覧する。他ツールに渡す tasklist ID はここで得る。",
      inputSchema: {
        maxResults: z.number().int().min(1).max(1000).optional().describe("取得件数の上限（既定 20、最大 1000）"),
        pageToken: z.string().optional().describe("次ページのトークン"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ maxResults, pageToken }) =>
      run(async () => {
        const data = await (await getApi()).listTaskLists({ maxResults, pageToken });
        return ok({
          items: (data.items ?? []).map(compactTaskList),
          nextPageToken: data.nextPageToken ?? null,
        });
      }),
  );

  server.registerTool(
    "get-tasklist",
    {
      title: "タスクリスト取得",
      description: "指定したタスクリストの情報を取得する。",
      inputSchema: { tasklist: tasklistArg },
      annotations: { readOnlyHint: true },
    },
    async ({ tasklist }) =>
      run(async () => {
        return ok(compactTaskList(await (await getApi()).getTaskList(tasklist)));
      }),
  );

  server.registerTool(
    "create-tasklist",
    {
      title: "タスクリスト作成",
      description: "新しいタスクリストを作成する。",
      inputSchema: { title: z.string().min(1).describe("タスクリスト名") },
    },
    async ({ title }) =>
      run(async () => {
        return ok(compactTaskList(await (await getApi()).createTaskList(title)));
      }),
  );

  server.registerTool(
    "update-tasklist",
    {
      title: "タスクリスト名の変更",
      description: "タスクリストの名前を変更する。",
      inputSchema: { tasklist: tasklistArg, title: z.string().min(1).describe("新しいタスクリスト名") },
    },
    async ({ tasklist, title }) =>
      run(async () => {
        return ok(compactTaskList(await (await getApi()).patchTaskList(tasklist, { title })));
      }),
  );

  server.registerTool(
    "delete-tasklist",
    {
      title: "タスクリスト削除",
      description: "タスクリストを削除する。中のタスクもすべて消える。取り消せない。",
      inputSchema: { tasklist: z.string().describe("削除するタスクリストの ID") },
      annotations: { destructiveHint: true },
    },
    async ({ tasklist }) =>
      run(async () => {
        await (await getApi()).deleteTaskList(tasklist);
        return ok({ deleted: tasklist });
      }),
  );

  // ---------- タスク ----------

  server.registerTool(
    "list-tasks",
    {
      title: "タスク一覧",
      description:
        "タスクリスト内のタスクを一覧する。期限や更新日時での絞り込みができる。" +
        "API 経由で完了にしたタスクは既定でも一覧に含まれる（clear-completed-tasks で非表示にできる）。",
      inputSchema: {
        tasklist: tasklistArg,
        showCompleted: z.boolean().optional().describe("完了済みタスクを含めるか（Google API の既定は true）。false にすると完了タスクを除外できる。"),
        showHidden: z.boolean().optional().describe("非表示タスク（他クライアントで完了扱いになったもの）も含める"),
        showDeleted: z.boolean().optional().describe("削除済みタスクも含める"),
        dueMin: z.string().optional().describe("期限の下限。指定日を含む（RFC 3339。日付部分のみ使われる）"),
        dueMax: z.string().optional().describe("期限の上限。指定日を含む（RFC 3339。日付部分のみ使われる）。今日までのタスクなら今日の日付を渡す。"),
        completedMin: z.string().optional().describe("完了日時の下限（RFC 3339）"),
        completedMax: z.string().optional().describe("完了日時の上限（RFC 3339）"),
        updatedMin: z.string().optional().describe("更新日時の下限（RFC 3339）"),
        maxResults: z.number().int().min(1).max(100).optional().describe("取得件数の上限（既定 20、最大 100）"),
        pageToken: z.string().optional().describe("次ページのトークン"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        // showCompleted のみ指定された場合、showHidden なしでは他クライアントで完了したタスクが返らない
        const showHidden = args.showHidden ?? (args.showCompleted === true ? true : undefined);
        const { dueMin, dueMax } = normalizeDueRange(args.dueMin, args.dueMax);
        const { tasklist, ...rest } = args;
        const data = await (await getApi()).listTasks(tasklist, { ...rest, showHidden, dueMin, dueMax });
        return ok({
          items: (data.items ?? []).map(compactTask),
          nextPageToken: data.nextPageToken ?? null,
        });
      }),
  );

  server.registerTool(
    "get-task",
    {
      title: "タスク取得",
      description: "タスク 1 件の詳細を取得する。",
      inputSchema: { tasklist: tasklistArg, task: taskArg },
      annotations: { readOnlyHint: true },
    },
    async ({ tasklist, task }) =>
      run(async () => {
        return ok(compactTask(await (await getApi()).getTask(tasklist, task)));
      }),
  );

  server.registerTool(
    "create-task",
    {
      title: "タスク作成",
      description: "タスクを作成する。parent を指定するとサブタスクになる。",
      inputSchema: {
        tasklist: tasklistArg,
        title: z.string().min(1).describe("タスクのタイトル"),
        notes: z.string().optional().describe("メモ・詳細"),
        due: z.string().optional().describe(dueDescription),
        parent: z.string().optional().describe("親タスクの ID。指定するとサブタスクとして作成する。"),
        previous: z.string().optional().describe("直前に置くタスクの ID。省略するとリストの先頭に入る。"),
      },
    },
    async ({ tasklist, title, notes, due, parent, previous }) =>
      run(async () => {
        const task = await (await getApi()).insertTask(tasklist, { title, notes, due }, { parent, previous });
        return ok(compactTask(task));
      }),
  );

  server.registerTool(
    "update-task",
    {
      title: "タスク更新",
      description:
        "タスクの内容を部分更新する。指定した項目だけが変わり、他は保持される。" +
        "完了にするだけなら complete-task を使う。",
      inputSchema: {
        tasklist: tasklistArg,
        task: taskArg,
        title: z.string().min(1).optional().describe("新しいタイトル"),
        notes: z.string().optional().describe("新しいメモ。空文字を渡すとメモを消す。"),
        due: z.string().optional().describe(dueDescription),
        status: z.enum(["needsAction", "completed"]).optional().describe("状態。completed にすると完了扱いになる。"),
      },
    },
    async ({ tasklist, task, ...fields }) =>
      run(async () => {
        const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (Object.keys(body).length === 0) {
          return fail("更新する項目が 1 つも指定されていません。title / notes / due / status のいずれかを指定してください。");
        }
        // update ではなく patch を使う。update は未指定フィールドを消してしまう。
        return ok(compactTask(await (await getApi()).patchTask(tasklist, task, body)));
      }),
  );

  server.registerTool(
    "complete-task",
    {
      title: "タスクを完了にする",
      description: "タスクを完了にする。completed を false にすると未完了に戻す。",
      inputSchema: {
        tasklist: tasklistArg,
        task: taskArg,
        completed: z.boolean().default(true).describe("true で完了、false で未完了に戻す"),
      },
    },
    async ({ tasklist, task, completed }) =>
      run(async () => {
        // 未完了に戻すときは completed 日時も明示的に消す必要がある
        const body = completed
          ? { status: "completed" as const }
          : { status: "needsAction" as const, completed: null };
        return ok(compactTask(await (await getApi()).patchTask(tasklist, task, body)));
      }),
  );

  server.registerTool(
    "move-task",
    {
      title: "タスクの移動・並べ替え",
      description:
        "タスクの位置を変える。parent でサブタスク化、previous で並び順、" +
        "destinationTasklist で別のタスクリストへ移動できる。",
      inputSchema: {
        tasklist: tasklistArg,
        task: taskArg,
        parent: z.string().optional().describe("移動先の親タスク ID。省略するとトップレベルになる。"),
        previous: z.string().optional().describe("直前に置くタスクの ID。省略すると先頭に移動する。"),
        destinationTasklist: z.string().optional().describe("移動先のタスクリスト ID（別リストへ移す場合）"),
      },
    },
    async ({ tasklist, task, parent, previous, destinationTasklist }) =>
      run(async () => {
        const moved = await (await getApi()).moveTask(tasklist, task, { parent, previous, destinationTasklist });
        return ok(compactTask(moved));
      }),
  );

  server.registerTool(
    "delete-task",
    {
      title: "タスク削除",
      description: "タスクを削除する。取り消せない。",
      inputSchema: { tasklist: tasklistArg, task: taskArg },
      annotations: { destructiveHint: true },
    },
    async ({ tasklist, task }) =>
      run(async () => {
        await (await getApi()).deleteTask(tasklist, task);
        return ok({ deleted: task, tasklist });
      }),
  );

  server.registerTool(
    "clear-completed-tasks",
    {
      title: "完了タスクの一括非表示",
      description:
        "タスクリスト内の完了済みタスクをまとめて非表示にする。" +
        "一覧には出なくなるが、showHidden: true を指定すれば取得できる。",
      inputSchema: { tasklist: tasklistArg },
      annotations: { destructiveHint: true },
    },
    async ({ tasklist }) =>
      run(async () => {
        await (await getApi()).clearCompleted(tasklist);
        return ok({ cleared: tasklist });
      }),
  );
}
