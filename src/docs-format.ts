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
  /** Heading level: 0 for TITLE, 1-6 for HEADING_n. Undefined for body text. */
  level?: number;
}

function headingLevel(paragraph: Paragraph): number | undefined {
  const style = paragraph.paragraphStyle?.namedStyleType ?? "";
  if (style === "TITLE") return 0;
  const m = /^HEADING_(\d)$/.exec(style);
  return m ? Number(m[1]) : undefined;
}

/** Top-level body paragraphs (not inside tables), with their indexes. */
export function bodyParagraphs(doc: Document): ParagraphRef[] {
  const refs: ParagraphRef[] = [];
  for (const element of doc.body?.content ?? []) {
    if (!element.paragraph || element.startIndex === undefined || element.endIndex === undefined) continue;
    const level = headingLevel(element.paragraph);
    refs.push({
      startIndex: element.startIndex,
      endIndex: element.endIndex,
      text: paragraphText(element.paragraph),
      ...(level === undefined ? {} : { level }),
    });
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

export interface InlineSpan {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  link?: string;
}

interface ParsedLine {
  text: string;
  style: LineStyle;
  spans: InlineSpan[];
}

/**
 * Inline Markdown: **bold**, *italic* / _italic_, and [text](https://url). Markers are removed
 * and the formatting is returned as spans over the plain text. No nesting.
 */
export function parseInline(input: string): { text: string; spans: InlineSpan[] } {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])/g;
  let text = "";
  const spans: InlineSpan[] = [];
  let last = 0;
  for (const m of input.matchAll(pattern)) {
    text += input.slice(last, m.index);
    const [, linkText, url, bold, star, under] = m;
    const inner = linkText ?? bold ?? star ?? under ?? "";
    const span: InlineSpan = { start: text.length, end: text.length + inner.length };
    if (url) span.link = url;
    else if (bold) span.bold = true;
    else span.italic = true;
    spans.push(span);
    text += inner;
    last = m.index + m[0].length;
  }
  return { text: text + input.slice(last), spans };
}

/** Light Markdown: "# ", "## ", "### " headings, "- " / "* " bullets, plus inline formatting. */
export function parseMarkdownLines(input: string): ParsedLine[] {
  const lines = input.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return lines.map((line) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = heading ? null : /^\s*[-*]\s+(.*)$/.exec(line);
    const style: LineStyle = heading ? (`HEADING_${heading[1]!.length}` as LineStyle) : bullet ? "BULLET" : "NORMAL_TEXT";
    return { ...parseInline(heading ? heading[2]! : bullet ? bullet[1]! : line), style };
  });
}

/**
 * Requests that insert `markdown` as new paragraphs right after `after`.
 *
 * Inserting "\n" + text just before the anchor's trailing newline closes the anchor paragraph
 * and starts new ones. New text inherits the anchor's paragraph style (a heading stays a heading)
 * and its character style (bold, links), so both are reset explicitly before applying what the
 * Markdown asks for. If the anchor is an empty paragraph, the text fills it instead of leaving a
 * blank line.
 */
export function buildInsertRequests(after: ParagraphRef, markdown: string): object[] {
  const lines = parseMarkdownLines(markdown);
  const plain = lines.map((line) => line.text).join("\n");
  if (!plain.trim()) throw new Error("content is empty.");
  const fillEmpty = after.text === "";
  const insertAt = after.endIndex - 1;
  const start = fillEmpty ? after.startIndex : after.endIndex;

  const requests: object[] = [
    { insertText: { location: { index: insertAt }, text: fillEmpty ? plain : "\n" + plain } },
    // Clear any bullet inherited from the anchor; bullets are re-added below where asked.
    { deleteParagraphBullets: { range: { startIndex: start, endIndex: start + plain.length + 1 } } },
  ];
  requests.push({
    updateTextStyle: { range: { startIndex: start, endIndex: start + plain.length }, textStyle: {}, fields: "bold,italic,link" },
  });

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
    for (const span of line.spans) {
      const textStyle = span.link ? { link: { url: span.link } } : span.bold ? { bold: true } : { italic: true };
      requests.push({
        updateTextStyle: {
          range: { startIndex: offset + span.start, endIndex: offset + span.end },
          textStyle,
          fields: span.link ? "link" : span.bold ? "bold" : "italic",
        },
      });
    }
    if (line.style === "BULLET") bulletRunStart ??= offset;
    else closeBulletRun(offset);
    offset = range.endIndex;
  }
  closeBulletRun(offset);
  return requests;
}

/**
 * Requests that delete a paragraph, or a heading's whole section (the heading plus everything
 * up to the next heading of the same or higher level). Also returns how many paragraphs it covers.
 *
 * A document's final newline can't be deleted, so a range reaching the end of the body stops
 * just before it, leaving an empty last paragraph. (Taking the preceding newline instead would
 * merge the previous paragraph into the last one and silently change its style.) That empty
 * paragraph keeps the style of the deleted last paragraph, e.g. a bullet, so it is reset to plain text.
 */
export function buildDeleteRequests(
  doc: Document,
  anchor: ParagraphRef,
  wholeSection: boolean,
): { requests: object[]; paragraphs: number } {
  if (wholeSection && anchor.level === undefined) {
    throw new Error(`"${anchor.text}" isn't a heading, so it has no section. Delete it as a single paragraph instead.`);
  }
  const content = doc.body?.content ?? [];
  const bodyEnd = content.at(-1)?.endIndex ?? anchor.endIndex;
  const paragraphs = bodyParagraphs(doc);
  let end = anchor.endIndex;
  if (wholeSection) {
    const next = paragraphs.find((p) => p.startIndex > anchor.startIndex && p.level !== undefined && p.level <= anchor.level!);
    end = next ? next.startIndex : bodyEnd;
  }
  const covered = paragraphs.filter((p) => p.startIndex >= anchor.startIndex && p.endIndex <= end).length;
  const start = anchor.startIndex;
  const atEnd = end >= bodyEnd;
  if (atEnd) end = bodyEnd - 1;
  if (end <= start) throw new Error("Nothing to delete: that's the document's empty last paragraph.");
  const requests: object[] = [{ deleteContentRange: { range: { startIndex: start, endIndex: end } } }];
  if (atEnd) {
    const last = { startIndex: start, endIndex: start + 1 };
    requests.push(
      { deleteParagraphBullets: { range: last } },
      { updateParagraphStyle: { range: last, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
    );
  }
  return { requests, paragraphs: covered };
}
