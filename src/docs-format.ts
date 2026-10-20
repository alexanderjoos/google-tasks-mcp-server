/**
 * Pure helpers for Google Docs: render a document as light Markdown, find paragraphs by text,
 * and build the batchUpdate requests that insert Markdown-ish text as styled paragraphs.
 *
 * Docs indexes count UTF-16 code units, the same unit as JS string length, so lengths below
 * map directly to document indexes.
 */
import type { Document, Paragraph, StructuralElement } from "./docs-api.js";

const HEADING_PREFIX: Record<string, string> = {
  TITLE: "# ",
  HEADING_1: "# ",
  HEADING_2: "## ",
  HEADING_3: "### ",
  HEADING_4: "#### ",
  HEADING_5: "##### ",
  HEADING_6: "###### ",
};

/** A paragraph's text without its trailing newline. */
export function paragraphText(paragraph: Paragraph): string {
  return (paragraph.elements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("")
    .replace(/\n$/, "");
}

function paragraphToMarkdown(paragraph: Paragraph): string {
  const text = paragraphText(paragraph);
  if (paragraph.bullet) return "  ".repeat(paragraph.bullet.nestingLevel ?? 0) + "- " + text;
  const prefix = HEADING_PREFIX[paragraph.paragraphStyle?.namedStyleType ?? ""];
  return prefix && text ? prefix + text : text;
}

function elementsToLines(content: StructuralElement[]): string[] {
  const lines: string[] = [];
  for (const element of content) {
    if (element.paragraph) {
      lines.push(paragraphToMarkdown(element.paragraph));
    } else if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((cell) =>
          elementsToLines(cell.content ?? [])
            .filter(Boolean)
            .join(" / ")
            .replaceAll("|", "\\|"),
        );
        lines.push(`| ${cells.join(" | ")} |`);
      }
    }
    // Section breaks and the table of contents carry no user text worth returning.
  }
  return lines;
}

/** Render the body as light Markdown (headings, bullets, tables as pipe rows). */
export function documentToMarkdown(doc: Document, maxChars: number): { text: string; truncated: boolean } {
  const text = elementsToLines(doc.body?.content ?? [])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export interface ParagraphRef {
  startIndex: number;
  endIndex: number;
  text: string;
}

/** Top-level body paragraphs (not inside tables), with their indexes. */
export function bodyParagraphs(doc: Document): ParagraphRef[] {
  const refs: ParagraphRef[] = [];
  for (const element of doc.body?.content ?? []) {
    if (!element.paragraph || element.startIndex === undefined || element.endIndex === undefined) continue;
    refs.push({ startIndex: element.startIndex, endIndex: element.endIndex, text: paragraphText(element.paragraph) });
  }
  return refs;
}

/** Strip a leading Markdown heading or bullet marker, so "## Notes" matches the heading "Notes". */
function stripMarker(text: string): string {
  return text.replace(/^\s*(#{1,6}|[-*])\s+/, "").trim();
}

/**
 * Find the one paragraph matching `anchor`. An exact (case-insensitive) match wins; otherwise
 * the anchor must be contained in exactly one paragraph. Ambiguity is an error, not a guess.
 */
export function findAnchorParagraph(doc: Document, anchor: string): ParagraphRef {
  const needle = stripMarker(anchor).toLowerCase();
  if (!needle) throw new Error("anchor_text is empty.");
  const paragraphs = bodyParagraphs(doc);
  const exact = paragraphs.filter((p) => p.text.trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  const matches = exact.length > 1 ? exact : paragraphs.filter((p) => p.text.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No paragraph contains "${anchor}". Read the doc with docs_read to pick an exact anchor.`);
  throw new Error(
    `"${anchor}" matches ${matches.length} paragraphs. Pass more of the paragraph's text so it matches exactly one.`,
  );
}

type LineStyle = "NORMAL_TEXT" | "HEADING_1" | "HEADING_2" | "HEADING_3" | "BULLET";

interface ParsedLine {
  text: string;
  style: LineStyle;
}

/** Light Markdown: "# ", "## ", "### " headings and "- " / "* " bullets. Everything else is plain text. */
export function parseMarkdownLines(input: string): ParsedLine[] {
  const lines = input.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return lines.map((line) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) return { text: heading[2]!, style: `HEADING_${heading[1]!.length}` as LineStyle };
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) return { text: bullet[1]!, style: "BULLET" };
    return { text: line, style: "NORMAL_TEXT" };
  });
}

/**
 * Requests that insert `markdown` as new paragraphs right after `after`.
 *
 * Inserting "\n" + text just before the anchor's trailing newline closes the anchor paragraph
 * and starts new ones. New paragraphs inherit the anchor's style (a heading stays a heading),
 * so every inserted line gets its style set explicitly. If the anchor is an empty paragraph,
 * the text fills it instead of leaving a blank line.
 */
export function buildInsertRequests(after: ParagraphRef, markdown: string): object[] {
  const lines = parseMarkdownLines(markdown);
  const plain = lines.map((line) => line.text).join("\n");
  const fillEmpty = after.text === "";
  const insertAt = after.endIndex - 1;
  const start = fillEmpty ? after.startIndex : after.endIndex;

  const requests: object[] = [
    { insertText: { location: { index: insertAt }, text: fillEmpty ? plain : "\n" + plain } },
    // Clear any bullet inherited from the anchor; bullets are re-added below where asked.
    { deleteParagraphBullets: { range: { startIndex: start, endIndex: start + plain.length + 1 } } },
  ];

  let offset = start;
  let bulletRunStart: number | null = null;
  const closeBulletRun = (end: number) => {
    if (bulletRunStart === null) return;
    requests.push({
      createParagraphBullets: {
        range: { startIndex: bulletRunStart, endIndex: end },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
    bulletRunStart = null;
  };

  for (const line of lines) {
    // +1 covers the paragraph's newline, so empty lines still get a non-empty range.
    const range = { startIndex: offset, endIndex: offset + line.text.length + 1 };
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: { namedStyleType: line.style === "BULLET" ? "NORMAL_TEXT" : line.style },
        fields: "namedStyleType",
      },
    });
    if (line.style === "BULLET") bulletRunStart ??= offset;
    else closeBulletRun(offset);
    offset = range.endIndex;
  }
  closeBulletRun(offset);
  return requests;
}
