/* parseMarkdownTable (11-import.js) — the pipe-table reader.
 *
 * Two callers with very different needs, which is why this is worth
 * pinning on its own: the Paste/Import modal reads a table somebody made
 * somewhere else, and parseMarkdownProject (20d-formats.js) reads the
 * scene table out of one of our OWN `.md` files, where the row count has
 * to line up with the file's record exactly or every scene after a
 * dropped one is misread as shifted.
 *
 * It had no test of its own before #67 — it was only ever exercised
 * through an import in a real browser, where a wrong answer shows up as
 * mangled rows several steps later.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initStatus } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { detectTwoColumnFormat, parseImportRows, parseMarkdownTable } from "../js/11-import.js";
import { toMarkdownTableDoc } from "../js/14-export.js";

initTags();
initStatus();

const cells = (rows) => rows.map((r) => [r.visualText, r.audioText]);

test("a plain two-column table, header and separator both consumed", () => {
  const out = parseMarkdownTable([
    "| Visual | Audio |",
    "| --- | --- |",
    "| wide shot | Hello there. |",
    "| cutaway | And then this. |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["wide shot", "Hello there."], ["cutaway", "And then this."]]);
  assert.deepEqual(out.map((r) => r.statusText), ["", ""]);
});

test("no header at all: the first two columns are Visual and Audio", () => {
  const out = parseMarkdownTable("| a | b |\n| c | d |");
  assert.deepEqual(cells(out), [["a", "b"], ["c", "d"]]);
});

test("the header names the columns, wherever they sit", () => {
  const out = parseMarkdownTable([
    "| # | Narration | Screen | Status |",
    "| --- | --- | --- | --- |",
    "| 01 | Hello. | wide shot | shot |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["wide shot", "Hello."]]);
  assert.equal(out[0].statusText, "shot");
});

test("a header naming only one column never points both fields at it", () => {
  /* The unresolved side used to fall back to its bare default (0), which
     collides with the found one and silently duplicates a column. */
  const audioFirst = parseMarkdownTable("| Audio | Notes |\n| --- | --- |\n| Hello. | wide shot |");
  assert.deepEqual(cells(audioFirst), [["wide shot", "Hello."]]);

  const audioSecond = parseMarkdownTable("| Notes | Audio |\n| --- | --- |\n| wide shot | Hello. |");
  assert.deepEqual(cells(audioSecond), [["wide shot", "Hello."]]);

  const visualOnly = parseMarkdownTable("| Notes | Visual |\n| --- | --- |\n| Hello. | wide shot |");
  assert.deepEqual(cells(visualOnly), [["wide shot", "Hello."]]);
});

test("an escaped pipe stays inside its cell", () => {
  /* A plain split("|") cuts the cell in two and shifts every following
     column into the next index, truncating whatever lands past the end. */
  const out = parseMarkdownTable([
    "| Visual | Audio | Status |",
    "| --- | --- | --- |",
    "| a \\| b | c \\| d | shot |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["a | b", "c | d"]]);
  assert.equal(out[0].statusText, "shot");
});

test("a separator row is never data, however it is written", () => {
  const out = parseMarkdownTable([
    "| Visual | Audio |",
    "|:---|---:|",
    "| a | b |",
    "| :--: | :--: |",
    "| c | d |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["a", "b"], ["c", "d"]]);
});

test("lines with no pipe in them are ignored", () => {
  const out = parseMarkdownTable([
    "# A heading",
    "",
    "Some prose about the script.",
    "| Visual | Audio |",
    "| --- | --- |",
    "| a | b |"
  ].join("\n"));
  assert.deepEqual(cells(out), [["a", "b"]]);
});

test("a scene with nothing typed in it is dropped by default and kept with keepEmpty", () => {
  /* keepEmpty is for one of our own files, where a scene with nothing
     typed in it yet is still a scene — dropping it shifts every later row
     out of line with the file's own record and pops the "scenes were added
     or removed" question on every open. Our own writer always emits the
     scene number and the status, which is what makes the row visible to
     the reader at all — see the all-blank case below. */
  const md = [
    "| # | Visual | Audio | Status |",
    "| --- | --- | --- | --- |",
    "| 01 | a | b | todo |",
    "| 02 |  |  | todo |",
    "| 03 | c | d | todo |"
  ].join("\n");
  assert.deepEqual(cells(parseMarkdownTable(md)), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(cells(parseMarkdownTable(md, { keepEmpty: true })),
    [["a", "b"], ["", ""], ["c", "d"]]);
});

test("a row with nothing in ANY column reads as a separator, keepEmpty or not", () => {
  /* Not a scene: a table whose every cell is blank is indistinguishable
     from the "| --- | --- |" line, and is dropped by the same test. Worth
     pinning because keepEmpty's name suggests otherwise. */
  const md = "| Visual | Audio |\n| --- | --- |\n| a | b |\n|  |  |\n| c | d |";
  assert.deepEqual(cells(parseMarkdownTable(md, { keepEmpty: true })), [["a", "b"], ["c", "d"]]);
});

test("a row with only one of the two cells filled is always kept", () => {
  assert.deepEqual(cells(parseMarkdownTable("| Visual | Audio |\n| --- | --- |\n| a |  |\n|  | d |")),
    [["a", ""], ["", "d"]]);
});

test("CRLF and untrimmed cells", () => {
  const out = parseMarkdownTable("| Visual | Audio |\r\n| --- | --- |\r\n|   a   |   b   |\r\n");
  assert.deepEqual(cells(out), [["a", "b"]]);
});

test("nothing table-shaped at all gives an empty list, never a throw", () => {
  assert.deepEqual(parseMarkdownTable(""), []);
  assert.deepEqual(parseMarkdownTable("just some prose\nwith no pipes"), []);
  /* A header and separator with no data rows under them. */
  assert.deepEqual(parseMarkdownTable("| Visual | Audio |\n| --- | --- |"), []);
});

test("a short row does not read a neighbour's column", () => {
  const out = parseMarkdownTable("| Visual | Audio | Status |\n| --- | --- | --- |\n| a |");
  assert.deepEqual(cells(out), [["a", ""]]);
  assert.equal(out[0].statusText, "");
});

/* A "Two columns" Markdown export reopened (Import, no data block): the
   breakdown and comments after the script are pipe tables and lines too,
   and used to come back as extra scenes, "Item | Status" among them. */
test("a Two columns export reads back as its scenes only, not its breakdown or comments", () => {
  const tag = (cat, name) =>
    `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
  S.state = migrateRows({
    schema: 2, title: "Two col",
    rows: [
      { id: "r1", visualText: "Wide " + tag("vfx", "explosion"), audioText: "Hello there.", status: "todo" },
      { id: "r2", visualText: "Close on the " + tag("prop", "mug"), audioText: "Coffee time.", status: "todo" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", author: "Ann", body: "a | b | c",
      createdAt: "2026-09-01T10:00:00Z", replies: [] }]
  });
  const md = toMarkdownTableDoc();
  assert.match(md, /## Production breakdown/);
  assert.match(md, /## Comments/);
  const expected = [["Wide explosion", "Hello there."], ["Close on the mug", "Coffee time."]];
  assert.deepEqual(cells(parseMarkdownTable(md)), expected);
  assert.equal(detectTwoColumnFormat(md), "table");
  assert.deepEqual(cells(parseImportRows(md, "twocolumn")), expected);
});

test("someone else's table keeps what follows its own Comments heading", () => {
  /* Only our own scene header ("# | Visual | Audio | Status") ends the
     table at those headings, as only our table style does in a .docx. */
  const md = "| Visual | Audio |\n| --- | --- |\n| a | b |\n\n## Comments\n\n| c | d |";
  assert.deepEqual(cells(parseMarkdownTable(md)), [["a", "b"], ["c", "d"]]);
});
