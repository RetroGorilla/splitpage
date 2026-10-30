import test from "node:test";
import assert from "node:assert/strict";
import { columnIndicesFromHeader, markdownExportScript, parseMarkdownTable } from "../../../src/adapters/formats/markdown-table.ts";

const cells = (rows) => rows.map((r) => [r.visualText, r.audioText]);

test("each visual heading is found, in the singular, the plural and any case", () => {
  for (const word of ["visual", "video", "scene", "shot", "b-roll", "broll", "image", "screen"]) {
    for (const head of [word, word + "s", word.toUpperCase(), " " + word + " "]) {
      assert.deepEqual(columnIndicesFromHeader(["x", head]), { visualIdx: 1, audioIdx: 0 }, head);
    }
  }
});

test("each audio heading is found, in the singular, the plural and any case", () => {
  for (const word of ["audio", "vo", "voiceover", "voice-over", "narration", "dialogue", "script"]) {
    for (const head of [word, word + "s", word.toUpperCase(), " " + word + " "]) {
      assert.deepEqual(columnIndicesFromHeader(["x", head]), { visualIdx: 0, audioIdx: 1 }, head);
    }
  }
});

test("a heading that merely contains a keyword is not that column", () => {
  for (const head of ["my visual", "visual notes", "the audio", "scripted", "audio track"]) {
    assert.deepEqual(columnIndicesFromHeader(["x", head]), { visualIdx: -1, audioIdx: -1 }, head);
  }
});

test("one named column places the other beside it", () => {
  assert.deepEqual(columnIndicesFromHeader(["visual", "x"]), { visualIdx: 0, audioIdx: 1 });
  assert.deepEqual(columnIndicesFromHeader(["x", "visual"]), { visualIdx: 1, audioIdx: 0 });
  assert.deepEqual(columnIndicesFromHeader(["audio", "x"]), { visualIdx: 1, audioIdx: 0 });
  assert.deepEqual(columnIndicesFromHeader(["x", "audio"]), { visualIdx: 0, audioIdx: 1 });
  assert.deepEqual(columnIndicesFromHeader(["audio", "visual"]), { visualIdx: 1, audioIdx: 0 });
});

const OWN = ["| # | Visual | Audio | Status |", "|---|---|---|---|", "| 1 | a | b | todo |"].join("\n");
const WITH_TAIL = (heading) => OWN + "\n\n" + heading + "\n\n| Item | Count |\n|---|---|\n| x | 1 |";

test("the export's own table is cut before the sections that follow it", () => {
  for (const heading of ["## Production breakdown", "## B-roll shot list", "## Comments"]) {
    assert.equal(markdownExportScript(WITH_TAIL(heading)), OWN + "\n", heading);
  }
});

test("the cut tolerates indentation and trailing space but not other text", () => {
  assert.equal(markdownExportScript(WITH_TAIL("   ## Comments")), OWN + "\n");
  assert.equal(markdownExportScript(WITH_TAIL("## Comments   ")), OWN + "\n");
  for (const heading of ["##Comments", "text ## Comments", "## Comments extra", "### Comments", "## comments"]) {
    const text = WITH_TAIL(heading);
    assert.equal(markdownExportScript(text), text, heading);
  }
});

test("the header that starts the cut can be indented, in capitals or the longer form", () => {
  const tail = "\n## Comments\nmore";
  assert.equal(markdownExportScript("  | # | Visual | Audio | Status |\n| 1 | a | b | c |" + tail), "  | # | Visual | Audio | Status |\n| 1 | a | b | c |");
  assert.equal(markdownExportScript("| # | VISUAL | AUDIO | STATUS |\n| 1 | a | b | c |" + tail), "| # | VISUAL | AUDIO | STATUS |\n| 1 | a | b | c |");
  const long = "| # | Start | Status | Visual | Audio | Read |\n| 1 | 0 | todo | a | b | 1 |";
  assert.equal(markdownExportScript(long + tail), long);
  assert.equal(markdownExportScript("| # | Start | Status | Visual | Audio |\n| 1 |" + tail), "| # | Start | Status | Visual | Audio |\n| 1 |" + tail);
  assert.equal(markdownExportScript("| # | Visual | Audio |\n| 1 |" + tail), "| # | Visual | Audio |\n| 1 |" + tail);
});

test("a table that is not ours is never cut", () => {
  const text = "| Visual | Audio |\n| a | b |\n\n## Comments\n\n| c | d |";
  assert.equal(markdownExportScript(text), text);
});

test("the cut comes back with plain line breaks, and an uncut text comes back untouched", () => {
  const crlf = OWN.replace(/\n/g, "\r\n") + "\r\n\r\n## Comments\r\nrest";
  assert.equal(markdownExportScript(crlf), OWN + "\n");
  const plain = "| Visual | Audio |\r\n| a | b |\r\n";
  assert.equal(markdownExportScript(plain), plain);
  assert.equal(markdownExportScript(undefined), undefined);
});

test("a heading before the table does not cut anything", () => {
  const text = "## Comments\n\n" + OWN;
  assert.equal(markdownExportScript(text), text);
});

test("the cut keeps what is above the heading and nothing of the heading", () => {
  assert.equal(markdownExportScript(OWN + "\n## Comments"), OWN);
});

test("pipes at the edge of a row are optional", () => {
  assert.deepEqual(cells(parseMarkdownTable("Visual | Audio\nA | B")), [["A", "B"]]);
  assert.deepEqual(cells(parseMarkdownTable("A | B")), [["A", "B"]]);
  assert.deepEqual(cells(parseMarkdownTable("| A | B")), [["A", "B"]]);
  assert.deepEqual(cells(parseMarkdownTable("A | B |")), [["A", "B"]]);
  assert.deepEqual(cells(parseMarkdownTable("  | A | B |  ")), [["A", "B"]]);
});

test("a backslash only escapes a pipe", () => {
  assert.deepEqual(cells(parseMarkdownTable("| C:\\path | x \\| y |")), [["C:\\path", "x | y"]]);
});

test("separator rows need at least two dashes in every cell", () => {
  assert.deepEqual(cells(parseMarkdownTable("| - | - |")), [["-", "-"]]);
  assert.deepEqual(cells(parseMarkdownTable("| a-- | -- |")), [["a--", "--"]]);
  assert.deepEqual(cells(parseMarkdownTable("| --a | -- |")), [["--a", "--"]]);
  assert.deepEqual(cells(parseMarkdownTable("| A | B |\n| :-- | --: |\n| :--: | -- |\n| C | D |")), [["A", "B"], ["C", "D"]]);
  assert.deepEqual(cells(parseMarkdownTable("| A | B |\n| ---- | -- |\n| C | D |")), [["A", "B"], ["C", "D"]]);
});

test("rows are trimmed before the pipes are read", () => {
  assert.deepEqual(cells(parseMarkdownTable("   | A | B |   \n\t| C | D |")), [["A", "B"], ["C", "D"]]);
});

test("a table in the export's own format reads without its trailing sections", () => {
  assert.deepEqual(cells(parseMarkdownTable(WITH_TAIL("## Production breakdown"))), [["a", "b"]]);
});
