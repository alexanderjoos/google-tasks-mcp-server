import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CellValue, SheetsApi, Spreadsheet, ValueRenderOption } from "./sheets-api.js";
import { ok, fail, run } from "./format.js";
import { columnLetter, parseGoogleFileId, quoteTabName } from "./util.js";

/** Caps that keep tool responses and writes a sensible size for a chat model. */
const MAX_READ_CELLS = 5000;
const MAX_WRITE_CELLS = 10000;
/** Rows scanned by sheets_find_rows, and matches returned. */
const MAX_SCAN_ROWS = 5000;
const MAX_MATCHES = 50;

const spreadsheetArg = z
  .string()
  .min(1)
  .describe(
    "Spreadsheet URL (https://docs.google.com/spreadsheets/d/...) or ID. " +
      "To find a sheet by name, search Google Drive first, or ask the user for the link.",
  );

const rangeArg = z
  .string()
  .min(1)
  .describe(
    "A1 range including the tab, e.g. 'Sheet1!A1:D20', 'Sheet1!A:C', or just 'Sheet1' for the whole tab. " +
      "Quote tab names with spaces: \"'Job Apps'!A1:F\". Without a tab, the first tab is used.",
  );

const cellArg = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const valuesArg = z
  .array(z.array(cellArg))
  .min(1)
  .describe("Rows of cell values, e.g. [[\"Fidelity\", \"Offer\", \"2026-10-20\"]]. null leaves a cell unchanged.");

const rawArg = z
  .boolean()
  .default(false)
  .describe(
    "false (default): values are parsed like typing in the Sheets UI, so '=SUM(A:A)' is a formula and '2026-10-20' a date. " +
      "true: stored exactly as given.",
  );

const RENDER: Record<string, ValueRenderOption> = {
  formatted: "FORMATTED_VALUE",
  raw: "UNFORMATTED_VALUE",
  formulas: "FORMULA",
};

function cellCount(values: CellValue[][]): number {
  return values.reduce((sum, row) => sum + row.length, 0);
}

function compactSpreadsheet(sheet: Spreadsheet) {
  return {
    id: sheet.spreadsheetId,
    title: sheet.properties?.title,
    url: sheet.spreadsheetUrl,
    ...(sheet.properties?.timeZone ? { time_zone: sheet.properties.timeZone } : {}),
    tabs: (sheet.sheets ?? []).map(({ properties: p }) => ({
      title: p?.title,
      rows: p?.gridProperties?.rowCount,
      columns: p?.gridProperties?.columnCount,
      ...(p?.gridProperties?.frozenRowCount ? { frozen_rows: p.gridProperties.frozenRowCount } : {}),
    })),
  };
}

export function registerSheetsTools(server: McpServer, api: SheetsApi, timeZone: string): void {
  server.registerTool(
    "sheets_get_info",
    {
      title: "Get spreadsheet info",
      description: "Get a Google Sheets spreadsheet's title and tabs (with sizes). Use this before reading or writing to learn the tab names.",
      inputSchema: { spreadsheet: spreadsheetArg },
      annotations: { readOnlyHint: true },
    },
    async ({ spreadsheet }) => run(async () => ok(compactSpreadsheet(await api.getSpreadsheet(parseGoogleFileId(spreadsheet))))),
  );

  server.registerTool(
    "sheets_read",
    {
      title: "Read cells",
      description:
        `Read cell values from a range in a Google Sheet. Returns rows as arrays; trailing empty cells and rows are omitted. ` +
        `At most ${MAX_READ_CELLS} cells are returned, so read big sheets in chunks (e.g. 'Sheet1!A1:Z200').`,
      inputSchema: {
        spreadsheet: spreadsheetArg,
        range: rangeArg,
        render: z
          .enum(["formatted", "raw", "formulas"])
          .default("formatted")
          .describe("formatted (default): as shown in the UI. raw: underlying numbers. formulas: formulas instead of results."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ spreadsheet, range, render }) =>
      run(async () => {
        const data = await api.getValues(parseGoogleFileId(spreadsheet), range, RENDER[render]!);
        const rows: CellValue[][] = [];
        let cells = 0;
        for (const row of data.values ?? []) {
          if (cells + row.length > MAX_READ_CELLS) break;
          rows.push(row);
          cells += row.length;
        }
        const truncated = rows.length < (data.values?.length ?? 0);
        return ok({
          range: data.range,
          rows,
          ...(truncated ? { truncated: true, note: `Stopped at ${rows.length} rows. Read the rest with a narrower range.` } : {}),
        });
      }),
  );

  server.registerTool(
    "sheets_find_rows",
    {
      title: "Find rows",
      description:
        "Find rows in a tab whose cells contain some text (case-insensitive), e.g. the 'Fidelity' row of a job tracker. " +
        "Treats row 1 as the header. Returns each match's row number and exact A1 range, ready for sheets_write.",
      inputSchema: {
        spreadsheet: spreadsheetArg,
        tab: z.string().min(1).optional().describe("Tab name. Defaults to the first tab."),
        query: z.string().min(1).describe("Text to look for."),
        column: z.string().min(1).optional().describe("Only search this column, by header name (e.g. 'Company'). Default: all columns."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ spreadsheet, tab, query, column }) =>
      run(async () => {
        const range = `${tab === undefined ? "" : quoteTabName(tab) + "!"}A1:ZZ${MAX_SCAN_ROWS}`;
        const data = await api.getValues(parseGoogleFileId(spreadsheet), range, "FORMATTED_VALUE");
        const rows = data.values ?? [];
        const header = (rows[0] ?? []).map((cell) => String(cell ?? ""));
        let columnIndex: number | undefined;
        if (column !== undefined) {
          columnIndex = header.findIndex((h) => h.trim().toLowerCase() === column.trim().toLowerCase());
          if (columnIndex < 0) return fail(`No header named "${column}". Headers: ${header.filter(Boolean).join(", ")}`);
        }
        // The response range names the tab actually read ("Sheet1!A1:F40"), which matters when tab was omitted.
        const tabPrefix = data.range?.includes("!") ? data.range.slice(0, data.range.lastIndexOf("!") + 1) : "";
        const needle = query.toLowerCase();
        const width = Math.max(header.length, 1);
        const matches = [];
        let total = 0;
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i] ?? [];
          const cells = columnIndex === undefined ? row : [row[columnIndex]];
          if (!cells.some((cell) => String(cell ?? "").toLowerCase().includes(needle))) continue;
          total++;
          if (matches.length < MAX_MATCHES) {
            matches.push({ row: i + 1, range: `${tabPrefix}A${i + 1}:${columnLetter(Math.max(width, row.length))}${i + 1}`, values: row });
          }
        }
        return ok({
          header,
          matches,
          ...(total > matches.length ? { total_matches: total, note: "Showing the first matches only. Narrow the query." } : {}),
          ...(rows.length >= MAX_SCAN_ROWS ? { note_scan: `Only the first ${MAX_SCAN_ROWS} rows were searched.` } : {}),
        });
      }),
  );

  server.registerTool(
    "sheets_write",
    {
      title: "Write cells",
      description:
        "Overwrite cells in a Google Sheet starting at the range's top-left cell. Use for editing existing cells; " +
        "to add rows under existing data, use sheets_append_rows. Previous values can be restored from the sheet's version history.",
      inputSchema: { spreadsheet: spreadsheetArg, range: rangeArg, values: valuesArg, raw: rawArg },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ spreadsheet, range, values, raw }) =>
      run(async () => {
        if (cellCount(values) > MAX_WRITE_CELLS) return fail(`Too many cells (max ${MAX_WRITE_CELLS} per call). Split the write.`);
        const result = await api.updateValues(parseGoogleFileId(spreadsheet), range, values, raw);
        return ok({ updated_range: result.updatedRange, updated_cells: result.updatedCells });
      }),
  );

  server.registerTool(
    "sheets_append_rows",
    {
      title: "Append rows",
      description:
        "Add rows after the last row of data in a tab of a Google Sheet, e.g. logging an expense or a new job application. " +
        "Columns line up with the table's first column. Read the header row first so values go in the right columns.",
      inputSchema: {
        spreadsheet: spreadsheetArg,
        tab: z.string().min(1).optional().describe("Tab name. Defaults to the first tab."),
        values: valuesArg,
        raw: rawArg,
      },
    },
    async ({ spreadsheet, tab, values, raw }) =>
      run(async () => {
        if (cellCount(values) > MAX_WRITE_CELLS) return fail(`Too many cells (max ${MAX_WRITE_CELLS} per call). Split the append.`);
        const range = tab === undefined ? "A1" : quoteTabName(tab);
        const result = await api.appendValues(parseGoogleFileId(spreadsheet), range, values, raw);
        return ok({ updated_range: result.updates?.updatedRange, rows_added: result.updates?.updatedRows });
      }),
  );

  server.registerTool(
    "sheets_clear",
    {
      title: "Clear cells",
      description:
        "Clear the values in a range of a Google Sheet (formatting is kept). Only use when the user asked to clear or remove data. " +
        "Recoverable from the sheet's version history.",
      inputSchema: { spreadsheet: spreadsheetArg, range: rangeArg },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async ({ spreadsheet, range }) =>
      run(async () => ok({ cleared_range: (await api.clearValues(parseGoogleFileId(spreadsheet), range)).clearedRange })),
  );

  server.registerTool(
    "sheets_add_tab",
    {
      title: "Add tab",
      description: "Add a new tab (sheet) to an existing Google Sheets spreadsheet.",
      inputSchema: { spreadsheet: spreadsheetArg, title: z.string().min(1).describe("Name of the new tab.") },
    },
    async ({ spreadsheet, title }) =>
      run(async () => {
        const result = await api.addTab(parseGoogleFileId(spreadsheet), title);
        return ok({ added: result.replies?.[0]?.addSheet?.properties?.title ?? title });
      }),
  );

  server.registerTool(
    "sheets_create",
    {
      title: "Create spreadsheet",
      description: "Create a new Google Sheets spreadsheet in the user's Drive, optionally with named tabs and starting rows in the first tab.",
      inputSchema: {
        title: z.string().min(1).describe("Spreadsheet title."),
        tabs: z.array(z.string().min(1)).default([]).describe("Tab names. Defaults to one tab named 'Sheet1'."),
        time_zone: z
          .string()
          .optional()
          .describe(`IANA time zone for the sheet, which TODAY() and NOW() use. Defaults to ${timeZone}.`),
        rows: valuesArg.optional().describe("Optional starting rows for the first tab, e.g. a header row."),
      },
    },
    async ({ title, tabs, rows, time_zone }) =>
      run(async () => {
        if (rows && cellCount(rows) > MAX_WRITE_CELLS) return fail(`Too many cells (max ${MAX_WRITE_CELLS}). Create first, then append.`);
        const sheet = await api.createSpreadsheet(title, tabs, time_zone ?? timeZone);
        if (rows && sheet.spreadsheetId) {
          const firstTab = sheet.sheets?.[0]?.properties?.title ?? "Sheet1";
          await api.updateValues(sheet.spreadsheetId, `${quoteTabName(firstTab)}!A1`, rows, false);
        }
        return ok(compactSpreadsheet(sheet));
      }),
  );
}
