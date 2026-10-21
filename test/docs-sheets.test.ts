import { test } from "node:test";
import assert from "node:assert/strict";
import { columnLetter, parseGoogleFileId, quoteTabName } from "../src/util.ts";
import {
  buildDeleteRequests,
  buildInsertRequests,
  documentToMarkdown,
  findAnchorParagraph,
  parseInline,
  parseMarkdownLines,
} from "../src/docs-format.ts";
import type { Document, StructuralElement } from "../src/docs-api.ts";

const ID = "1AbC_dEf-123456789xyz";

test("parseGoogleFileId accepts URLs and bare IDs", () => {
  assert.equal(parseGoogleFileId(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`), ID);
  assert.equal(parseGoogleFileId(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`), ID);
  assert.equal(parseGoogleFileId(`https://drive.google.com/open?id=${ID}`), ID);
  assert.equal(parseGoogleFileId(`  ${ID} `), ID);
  assert.throws(() => parseGoogleFileId("my budget sheet"));
  assert.throws(() => parseGoogleFileId("https://example.com/"));
});

test("quoteTabName escapes quotes", () => {
  assert.equal(quoteTabName("Job Apps"), "'Job Apps'");
  assert.equal(quoteTabName("O'Brien"), "'O''Brien'");
});

/** Build a doc whose paragraphs get consecutive indexes, starting at 1 like a real body. */
function makeDoc(paragraphs: { text: string; style?: string; bullet?: boolean }[]): Document {
  const content: StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
  let index = 1;
  for (const p of paragraphs) {
    const run = p.text + "\n";
    content.push({
      startIndex: index,
      endIndex: index + run.length,
      paragraph: {
        elements: [{ textRun: { content: run } }],
        paragraphStyle: { namedStyleType: p.style ?? "NORMAL_TEXT" },
        ...(p.bullet ? { bullet: { listId: "l1" } } : {}),
      },
    });
    index += run.length;
  }
  return { documentId: "d", title: "T", revisionId: "r1", body: { content } };
}

const sample = makeDoc([
  { text: "Plan", style: "HEADING_1" },
  { text: "Intro text." },
  { text: "Next steps", style: "HEADING_2" },
  { text: "call recruiter", bullet: true },
  { text: "Notes", style: "HEADING_2" },
  { text: "" },
]);

test("documentToMarkdown renders headings, bullets, and truncates", () => {
  const { text, truncated } = documentToMarkdown(sample, 1000);
  assert.equal(text, "# Plan\nIntro text.\n## Next steps\n- call recruiter\n## Notes");
  assert.equal(truncated, false);
  assert.deepEqual(documentToMarkdown(sample, 6), { text: "# Plan", truncated: true });
});

test("documentToMarkdown flattens tables into pipe rows", () => {
  const cell = (text: string) => ({ content: makeDoc([{ text }]).body!.content!.slice(1) });
  const doc: Document = {
    body: { content: [{ table: { tableRows: [{ tableCells: [cell("a|b"), cell("c")] }] } }] },
  };
  assert.equal(documentToMarkdown(doc, 1000).text, "| a\\|b | c |");
});

test("findAnchorParagraph prefers exact, strips markdown, rejects ambiguity", () => {
  assert.equal(findAnchorParagraph(sample, "## Next steps").text, "Next steps");
  assert.equal(findAnchorParagraph(sample, "intro").text, "Intro text.");
  const dup = makeDoc([{ text: "Notes" }, { text: "Notes and more" }, { text: "More notes" }]);
  assert.equal(findAnchorParagraph(dup, "notes").text, "Notes", "exact match beats contains");
  assert.throws(() => findAnchorParagraph(dup, "more"), /matches 2 paragraphs/);
  assert.throws(() => findAnchorParagraph(sample, "nope"), /No paragraph/);
});

test("parseMarkdownLines handles headings, bullets, CRLF and trailing newlines", () => {
  assert.deepEqual(parseMarkdownLines("## H\r\n- a\n* b\nplain\n\n"), [
    { text: "H", style: "HEADING_2", spans: [] },
    { text: "a", style: "BULLET", spans: [] },
    { text: "b", style: "BULLET", spans: [] },
    { text: "plain", style: "NORMAL_TEXT", spans: [] },
  ]);
  assert.deepEqual(parseMarkdownLines("#### deep"), [{ text: "#### deep", style: "NORMAL_TEXT", spans: [] }]);
});

test("buildInsertRequests after a heading: new paragraph, explicit styles, grouped bullets", () => {
  const heading = findAnchorParagraph(sample, "Next steps"); // "Next steps\n" at [18, 29)
  assert.deepEqual([heading.startIndex, heading.endIndex], [18, 29]);
  const requests = buildInsertRequests(heading, "- email Steve\n- prep\nDone.") as Record<string, any>[];

  assert.deepEqual(requests[0], { insertText: { location: { index: 28 }, text: "\n" + "email Steve\nprep\nDone." } });
  // Inserted paragraphs: "email Steve\n" [29,41), "prep\n" [41,46), "Done.\n" [46,52)
  assert.deepEqual(requests[1], { deleteParagraphBullets: { range: { startIndex: 29, endIndex: 52 } } });
  const styles = requests.filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle.range);
  assert.deepEqual(styles, [
    { startIndex: 29, endIndex: 41 },
    { startIndex: 41, endIndex: 46 },
    { startIndex: 46, endIndex: 52 },
  ]);
  const bullets = requests.filter((r) => r.createParagraphBullets);
  assert.equal(bullets.length, 1);
  assert.deepEqual(bullets[0].createParagraphBullets.range, { startIndex: 29, endIndex: 46 });
  assert.ok(requests.every((r) => !r.updateParagraphStyle || r.updateParagraphStyle.paragraphStyle.namedStyleType !== "HEADING_2"));
});

test("buildInsertRequests fills an empty paragraph instead of adding a blank line", () => {
  const empty = { startIndex: 1, endIndex: 2, text: "" };
  const requests = buildInsertRequests(empty, "# Title\nbody") as Record<string, any>[];
  assert.deepEqual(requests[0], { insertText: { location: { index: 1 }, text: "Title\nbody" } });
  const styles = requests.filter((r) => r.updateParagraphStyle).map((r) => r.updateParagraphStyle);
  assert.deepEqual(styles[0].range, { startIndex: 1, endIndex: 7 });
  assert.equal(styles[0].paragraphStyle.namedStyleType, "HEADING_1");
  assert.deepEqual(styles[1].range, { startIndex: 7, endIndex: 12 });
});

test("columnLetter", () => {
  assert.deepEqual([1, 26, 27, 52, 702, 703].map(columnLetter), ["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
});

test("parseInline strips markers and returns spans", () => {
  assert.deepEqual(parseInline("Call **Steve** re [offer](https://x.com/o) *today*"), {
    text: "Call Steve re offer today",
    spans: [
      { start: 5, end: 10, bold: true },
      { start: 14, end: 19, link: "https://x.com/o" },
      { start: 20, end: 25, italic: true },
    ],
  });
  assert.deepEqual(parseInline("5 * 3 * 2 and snake_case_name"), { text: "5 * 3 * 2 and snake_case_name", spans: [] });
  assert.deepEqual(parseInline("_note_").spans, [{ start: 0, end: 4, italic: true }]);
});

test("buildInsertRequests resets inherited character style, then applies spans at the right offsets", () => {
  const heading = findAnchorParagraph(sample, "Next steps"); // [18, 29), new text starts at 29
  const requests = buildInsertRequests(heading, "- **email** Steve") as Record<string, any>[];
  assert.equal(requests[0].insertText.text, "\nemail Steve");
  const textStyles = requests.filter((r) => r.updateTextStyle).map((r) => r.updateTextStyle);
  assert.deepEqual(textStyles[0], { range: { startIndex: 29, endIndex: 40 }, textStyle: {}, fields: "bold,italic,link" });
  assert.deepEqual(textStyles[1], { range: { startIndex: 29, endIndex: 34 }, textStyle: { bold: true }, fields: "bold" });
  assert.throws(() => buildInsertRequests(heading, "\n\n"), /empty/);
});

test("buildDeleteRequests: single paragraph, section, end-of-doc and guard rails", () => {
  // sample: Plan[1,6) H1, Intro[6,18), Next steps[18,29) H2, call recruiter[29,44) bullet, Notes[44,50) H2, ""[50,51)
  const del = (startIndex: number, endIndex: number) => ({ deleteContentRange: { range: { startIndex, endIndex } } });
  const resetLast = (startIndex: number) => {
    const range = { startIndex, endIndex: startIndex + 1 };
    return [
      { deleteParagraphBullets: { range } },
      { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
    ];
  };

  const intro = findAnchorParagraph(sample, "Intro");
  assert.deepEqual(buildDeleteRequests(sample, intro, false), { requests: [del(6, 18)], paragraphs: 1 });

  const next = findAnchorParagraph(sample, "Next steps");
  assert.deepEqual(buildDeleteRequests(sample, next, true), { requests: [del(18, 44)], paragraphs: 2 });

  // Last section reaches the end of the body: stop before the final newline, leaving the
  // bullet above untouched, and reset the leftover empty paragraph to plain text.
  const notes = findAnchorParagraph(sample, "Notes");
  assert.deepEqual(buildDeleteRequests(sample, notes, true), { requests: [del(44, 50), ...resetLast(44)], paragraphs: 2 });

  // H1 section covers everything except the undeletable final newline.
  const plan = findAnchorParagraph(sample, "Plan");
  assert.deepEqual(buildDeleteRequests(sample, plan, true), { requests: [del(1, 50), ...resetLast(1)], paragraphs: 6 });

  assert.throws(() => buildDeleteRequests(sample, intro, true), /isn't a heading/);
  const lone = makeDoc([{ text: "" }]);
  assert.throws(() => buildDeleteRequests(lone, { startIndex: 1, endIndex: 2, text: "" }, false), /empty last paragraph/);
});
