import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DocsApi } from "./docs-api.js";
import { ok, fail, run } from "./format.js";
import { bodyParagraphs, buildInsertRequests, documentToMarkdown, findAnchorParagraph } from "./docs-format.js";
import { parseGoogleFileId } from "./util.js";

/** Keeps docs_read responses a sensible size for a chat model. */
const MAX_READ_CHARS = 60000;

const documentArg = z
  .string()
  .min(1)
  .describe(
    "Google Doc URL (https://docs.google.com/document/d/...) or ID. " +
      "To find a doc by name, search Google Drive first, or ask the user for the link.",
  );

const contentArg = z
  .string()
  .min(1)
  .describe(
    "Text to insert. One paragraph per line. Supports '# ', '## ', '### ' headings and '- ' bullets; " +
      "other Markdown (bold, links, tables) is inserted as plain text.",
  );

function docUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

export function registerDocsTools(server: McpServer, api: DocsApi): void {
  server.registerTool(
    "docs_read",
    {
      title: "Read doc",
      description:
        "Read a Google Doc as light Markdown (headings, bullets, tables as | rows). Only the first tab is read. " +
        "Use this before editing to find exact anchor text.",
      inputSchema: { document: documentArg },
      annotations: { readOnlyHint: true },
    },
    async ({ document }) =>
      run(async () => {
        const doc = await api.getDocument(parseGoogleFileId(document));
        const { text, truncated } = documentToMarkdown(doc, MAX_READ_CHARS);
        return ok({ id: doc.documentId, title: doc.title, text, ...(truncated ? { truncated: true } : {}) });
      }),
  );

  server.registerTool(
    "docs_append",
    {
      title: "Append to doc",
      description: "Add text at the end of a Google Doc.",
      inputSchema: { document: documentArg, content: contentArg },
    },
    async ({ document, content }) =>
      run(async () => {
        const id = parseGoogleFileId(document);
        const doc = await api.getDocument(id);
        const last = bodyParagraphs(doc).at(-1);
        if (!last) return fail("The document has no body paragraph to append after.");
        await api.batchUpdate(id, buildInsertRequests(last, content), doc.revisionId);
        return ok({ appended: true, url: docUrl(id) });
      }),
  );

  server.registerTool(
    "docs_insert_after",
    {
      title: "Insert into doc",
      description:
        "Insert new paragraphs right after the paragraph matching anchor_text, e.g. under a heading. " +
        "The anchor must match exactly one top-level paragraph (not inside a table); read the doc first.",
      inputSchema: {
        document: documentArg,
        anchor_text: z.string().min(1).describe("Text of the paragraph to insert after, e.g. a heading like 'Next steps'."),
        content: contentArg,
      },
    },
    async ({ document, anchor_text, content }) =>
      run(async () => {
        const id = parseGoogleFileId(document);
        const doc = await api.getDocument(id);
        const anchor = findAnchorParagraph(doc, anchor_text);
        await api.batchUpdate(id, buildInsertRequests(anchor, content), doc.revisionId);
        return ok({ inserted_after: anchor.text, url: docUrl(id) });
      }),
  );

  server.registerTool(
    "docs_replace_text",
    {
      title: "Replace text in doc",
      description:
        "Replace every occurrence of some text in a Google Doc, keeping the surrounding formatting. " +
        "Use for fixing names, dates, or wording. Pass replace as '' to delete the text. Recoverable from the doc's version history.",
      inputSchema: {
        document: documentArg,
        find: z.string().min(1).describe("Exact text to find."),
        replace: z.string().describe("Replacement text. '' deletes the matches."),
        match_case: z.boolean().default(true).describe("Case-sensitive match. Default true."),
      },
      annotations: { destructiveHint: true },
    },
    async ({ document, find, replace, match_case }) =>
      run(async () => {
        const id = parseGoogleFileId(document);
        const result = await api.batchUpdate(id, [
          { replaceAllText: { containsText: { text: find, matchCase: match_case }, replaceText: replace } },
        ]);
        const changed = result.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
        if (changed === 0) return fail(`No matches for "${find}". Nothing changed.`);
        return ok({ occurrences_changed: changed, url: docUrl(id) });
      }),
  );

  server.registerTool(
    "docs_create",
    {
      title: "Create doc",
      description: "Create a new Google Doc in the user's Drive, optionally with starting content.",
      inputSchema: { title: z.string().min(1).describe("Document title."), content: contentArg.optional() },
    },
    async ({ title, content }) =>
      run(async () => {
        const doc = await api.createDocument(title);
        const id = doc.documentId!;
        if (content) {
          // A new doc's body is a section break plus one empty paragraph at index 1.
          const first = bodyParagraphs(doc)[0] ?? { startIndex: 1, endIndex: 2, text: "" };
          await api.batchUpdate(id, buildInsertRequests(first, content));
        }
        return ok({ id, title: doc.title, url: docUrl(id) });
      }),
  );
}
