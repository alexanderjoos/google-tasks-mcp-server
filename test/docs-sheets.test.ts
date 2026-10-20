import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoogleFileId, quoteTabName } from "../src/util.ts";
import {
  buildInsertRequests,
  documentToMarkdown,
  findAnchorParagraph,
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
    { text: "H", style: "HEADING_2" },
    { text: "a", style: "BULLET" },
    { text: "b", style: "BULLET" },
    { text: "plain", style: "NORMAL_TEXT" },
  ]);
  assert.deepEqual(parseMarkdownLines("#### deep"), [{ text: "#### deep", style: "NORMAL_TEXT" }]);
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
