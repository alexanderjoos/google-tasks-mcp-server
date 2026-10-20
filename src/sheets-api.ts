/**
 * Thin client for the Google Sheets REST API (v4).
 * Reference: https://developers.google.com/workspace/sheets/api/reference/rest
 */

import { createGoogleClient, type AccessTokenProvider } from "./google-api.js";

const BASE = "https://sheets.googleapis.com/v4";

export type CellValue = string | number | boolean | null;

export interface SheetProperties {
  sheetId?: number;
  title?: string;
  index?: number;
  gridProperties?: { rowCount?: number; columnCount?: number; frozenRowCount?: number };
}

export interface Spreadsheet {
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  properties?: { title?: string; locale?: string; timeZone?: string };
  sheets?: { properties?: SheetProperties }[];
}

export interface ValueRange {
  range?: string;
  majorDimension?: string;
  values?: CellValue[][];
}

export interface UpdateValuesResponse {
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

export type ValueRenderOption = "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA";

export class SheetsApi {
  private readonly request: ReturnType<typeof createGoogleClient>;

  constructor(getAccessToken: AccessTokenProvider) {
    this.request = createGoogleClient("Google Sheets", BASE, getAccessToken);
  }

  /** Title and tab list only, not cell data. */
  getSpreadsheet(id: string): Promise<Spreadsheet> {
    return this.request("GET", `/spreadsheets/${encodeURIComponent(id)}`, {
      query: { fields: "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties))" },
    });
  }

  createSpreadsheet(title: string, tabs: string[]): Promise<Spreadsheet> {
    return this.request("POST", "/spreadsheets", {
      body: {
        properties: { title },
        ...(tabs.length ? { sheets: tabs.map((tab) => ({ properties: { title: tab } })) } : {}),
      },
    });
  }

  getValues(id: string, range: string, render: ValueRenderOption): Promise<ValueRange> {
    return this.request("GET", `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`, {
      query: { valueRenderOption: render, dateTimeRenderOption: "FORMATTED_STRING" },
    });
  }

  /** USER_ENTERED parses input the way the Sheets UI does: formulas, numbers, dates. */
  updateValues(id: string, range: string, values: CellValue[][], raw: boolean): Promise<UpdateValuesResponse> {
    return this.request("PUT", `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}`, {
      query: { valueInputOption: raw ? "RAW" : "USER_ENTERED" },
      body: { range, majorDimension: "ROWS", values },
    });
  }

  /** Appends after the last row of the table found in `range`, inserting new rows. */
  appendValues(id: string, range: string, values: CellValue[][], raw: boolean): Promise<{ updates?: UpdateValuesResponse }> {
    return this.request("POST", `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:append`, {
      query: { valueInputOption: raw ? "RAW" : "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
      body: { majorDimension: "ROWS", values },
    });
  }

  clearValues(id: string, range: string): Promise<{ clearedRange?: string }> {
    return this.request("POST", `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}:clear`, { body: {} });
  }

  addTab(id: string, title: string): Promise<{ replies?: { addSheet?: { properties?: SheetProperties } }[] }> {
    return this.request("POST", `/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, {
      body: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
}
