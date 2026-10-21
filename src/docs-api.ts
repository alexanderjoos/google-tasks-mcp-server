/**
 * Thin client for the Google Docs REST API (v1).
 * Reference: https://developers.google.com/workspace/docs/api/reference/rest
 */

import { createGoogleClient, type AccessTokenProvider } from "./google-api.js";

const BASE = "https://docs.googleapis.com/v1";

export interface TextRun {
  content?: string;
}

export interface Paragraph {
  elements?: { textRun?: TextRun }[];
  paragraphStyle?: { namedStyleType?: string };
  bullet?: { listId?: string; nestingLevel?: number };
}

export interface StructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: Paragraph;
  table?: { tableRows?: { tableCells?: { content?: StructuralElement[] }[] }[] };
  sectionBreak?: object;
  tableOfContents?: { content?: StructuralElement[] };
}

export interface Document {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: StructuralElement[] };
}

export interface BatchUpdateResponse {
  replies?: { replaceAllText?: { occurrencesChanged?: number } }[];
  writeControl?: { requiredRevisionId?: string };
}

export class DocsApi {
  private readonly request: ReturnType<typeof createGoogleClient>;

  /** Accounts to try in order; see createGoogleClient. */
  constructor(accounts: AccessTokenProvider[]) {
    this.request = createGoogleClient("Google Docs", BASE, accounts);
  }

  /** Without includeTabsContent, the body is the first tab's content. */
  getDocument(id: string): Promise<Document> {
    return this.request("GET", `/documents/${encodeURIComponent(id)}`);
  }

  createDocument(title: string): Promise<Document> {
    return this.request("POST", "/documents", { body: { title } });
  }

  /**
   * Applies requests atomically. With requiredRevisionId, Google rejects the batch if the doc
   * changed since we read it, so computed indexes can't land in the wrong place.
   */
  batchUpdate(id: string, requests: object[], requiredRevisionId?: string): Promise<BatchUpdateResponse> {
    return this.request("POST", `/documents/${encodeURIComponent(id)}:batchUpdate`, {
      body: { requests, ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}) },
    });
  }
}
