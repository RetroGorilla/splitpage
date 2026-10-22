import "./_dom.mjs";
import "./_export-services-started.mjs";
import "./_preferences-started.mjs";
import { liveDoc, liveWithAssets } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initSceneStatus } from "../js/01-scene-status.js";
import { rowSeconds } from "../core/production/timing.ts";
import { productionReaders } from "../legacy/document-ports.ts";
import { migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { htmlToMarkdown, sanitizeHtml } from "../js/04-richtext.js";
import {
  breakLine, cellLength, directionRangeAt, directionShortcut, flattenDirections, fromHtml, importDirections,
  insideDirection, joinCells, mergeCells, normalizeCell, projection, replaceText, sliceCell, splitCell,
  spokenText, toDocxRuns, toHtml, toMarkdown, toPlainText, toggleDirection, typingMarks
} from "../js/04c-doc-model.js";
import { clipboardOfCell } from "../js/05c-clipboard.js";
import { __init as initTags } from "../js/07-production-tags.js";
import { replaceInHtml } from "../js/09-find-replace.js";
import { strBytes } from "../adapters/formats/bytes.ts";
import { zipRead, zipWrite } from "../adapters/formats/zip.ts";
import { toMarkdownDoc } from "../adapters/formats/export-text.ts";
import {
  audioDirectionsHtml, buildDocx, buildNarrationDocx, buildNarrationText, docxToRows, narrationRows
} from "../adapters/formats/docx.ts";
import { buildCsv } from "../adapters/formats/csv.ts";
import { prompterSceneHtml } from "../js/20-teleprompter.js";
import {
  applyMarkdownProject,
  buildMarkdownProject,
  buildSplitpageFile,
  parseMarkdownProject
} from "../js/20d-formats.js";
import { exportDocumentOf } from "../js/14b-export-kit.js";
import { parseSplitpageFile } from "../adapters/formats/splitpage-file.ts";
import { loadTestDocument } from "./_document.mjs";

initTags();
initSceneStatus();

const T = (text, marks) => ({ text, marks: marks || {} });
const D = (text, marks) => ({ text, marks: Object.assign({ dir: true }, marks || {}) });
const DIR = (inner) => `<span class="stage-dir">${inner}</span>`;
const tagSpan = (cat, name, inner) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${inner}</span>`;
const cmt = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const BROLL = '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span>';

function withState(s, fn) {
  const was = S.state;
  loadTestDocument(s);
  try { return fn(s); } finally { loadTestDocument(was); }
}

test("stored as a span of its own, read back as the dir mark, a fixed point of the sanitiser", () => {
  const html = "Hello " + DIR("beat") + " and on.";
  const cell = fromHtml(html);
  assert.deepEqual(cell, [T("Hello "), D("beat"), T(" and on.")]);
  assert.equal(toHtml(cell), html);
  assert.equal(sanitizeHtml(html), html);
  assert.deepEqual(fromHtml(toHtml(cell)), normalizeCell(cell));
  assert.equal(sanitizeHtml('<span class="stage-dir x" style="color:red" onclick="x()">b</span>'), DIR("b"));
});

test("one nesting: comments outside a direction, a link and a tag inside it", () => {
  const cell = [T("say "), D("look at the ", { cmt: ["c1"] }), D("mug", { cmt: ["c1"], tag: "t:prop:Mug" }),
    D(" now", { href: "https://e.x/" })];
  const html = toHtml(cell);
  assert.equal(html, "say " + cmt("c1", DIR("look at the " + tagSpan("prop", "Mug", "mug"))) +
    DIR('<a href="https://e.x/" target="_blank" rel="noopener"> now</a>'));
  assert.deepEqual(fromHtml(html), normalizeCell(cell));
  assert.equal(toHtml([D("a "), D("b", { b: true }), D(" c")]), DIR("a <strong>b</strong> c"));
});

test("a tag is all in a direction or not at all, and a b-roll key is never in one", () => {
  const half = normalizeCell([D("the ", {}), D("red ", { tag: "t:prop:Red mug" }), T("mug", { tag: "t:prop:Red mug" })]);
  assert.deepEqual(half, [D("the "), D("red mug", { tag: "t:prop:Red mug" })]);
  const key = fromHtml(DIR(BROLL + " gulls"));
  assert.equal(key[0].atom, "broll");
  assert.deepEqual(key[0].marks, {});
  assert.deepEqual(key[1], D(" gulls"));
});

test("typing carries a direction on only between two of its characters", () => {
  const cell = [T("Hi "), D("beat"), T(" on")];
  assert.equal(typingMarks(cell, 3).dir, undefined, "at its start");
  assert.equal(typingMarks(cell, 5).dir, true, "inside");
  assert.equal(typingMarks(cell, 7).dir, undefined, "at its end");
  assert.equal(insideDirection(cell, 7), false);
  assert.equal(insideDirection(cell, 5), true);
  const atEnd = [T("Hi "), D("beat")];
  assert.equal(typingMarks(atEnd, 7).dir, undefined, "at the end of the cell");
  assert.deepEqual(breakLine(cell, 5, 5).cell, [T("Hi "), D("be\nat"), T(" on")]);
  assert.deepEqual(breakLine(cell, 7, 7).cell, [T("Hi "), D("beat"), T("\n on")]);
});

test("replacing words inside a direction keeps them in it; splitting and joining keep it whole", () => {
  const cell = [T("Hi "), D("big beat"), T(" on")];
  assert.deepEqual(replaceText(cell, 3, 6, "long"), [T("Hi "), D("long beat"), T(" on")]);
  const [a, b] = splitCell(cell, 7);
  assert.deepEqual(a, [T("Hi "), D("big ")]);
  assert.deepEqual(b, [D("beat"), T(" on")]);
  assert.deepEqual(joinCells([T("Hi "), D("big")], [D("beat"), T(" on")], " "), [T("Hi "), D("big beat"), T(" on")]);
});

test("the Direction button: on over the words without their end spaces, off where it all is one", () => {
  const cell = [T("Hello  beat  world")];
  const on = toggleDirection(cell, 5, 13);
  assert.deepEqual(on, [T("Hello  "), D("beat"), T("  world")]);
  assert.deepEqual(toggleDirection(on, 7, 11), [T("Hello  beat  world")]);
  assert.deepEqual(toggleDirection(on, 7, 9), [T("Hello  be"), D("at"), T("  world")]);
  assert.deepEqual(toggleDirection(on, 7, 18), [T("Hello  "), D("beat  world")]);
  assert.deepEqual(toggleDirection(cell, 5, 7), cell);
  assert.deepEqual(directionRangeAt(on, 9), { from: 7, to: 11 });
  assert.deepEqual(directionRangeAt(on, 11), { from: 7, to: 11 }, "at its end");
  assert.deepEqual(directionRangeAt(on, 7), { from: 7, to: 11 }, "at its start");
  assert.equal(directionRangeAt(on, 3), null);
});

test("typing the second ')' of ((words)) makes them a direction and the brackets go", () => {
  const typed = fromHtml("Hello ((beat))");
  const got = directionShortcut(typed, 14);
  assert.deepEqual(got.cell, [T("Hello "), D("beat")]);
  assert.equal(got.end, 10);
  const mid = directionShortcut(fromHtml("Hi ((look left)) and on"), 16);
  assert.deepEqual(mid.cell, [T("Hi "), D("look left"), T(" and on")]);
  assert.deepEqual(directionShortcut(fromHtml("a (( beat )) b"), 12).cell, [T("a  "), D("beat"), T("  b")]);
  const rich = fromHtml("((hold the " + tagSpan("prop", "Mug", "mug") + " <strong>up</strong>))");
  const r = directionShortcut(rich, cellLength(rich));
  assert.deepEqual(r.cell, [D("hold the "), D("mug", { tag: "t:prop:Mug" }), D(" "), D("up", { b: true })]);
});

test("single brackets are prose, and so is anything the pairs do not cleanly hold", () => {
  const no = (html, pos) => {
    const c = fromHtml(html);
    assert.equal(directionShortcut(c, pos === undefined ? cellLength(c) : pos), null, html);
  };
  no("a (beat)");
  no("a (see (fig 1))");
  no("a (())");
  no("a ((  ))");
  no("a ((x)))", 8);
  no("((a (b) c))");
  no("((line<br>break))");
  no("((" + BROLL + " x))");
  no("((beat)) and on", 5);
  no("((" + DIR("already") + "))");
  no(tagSpan("prop", "((x", "((x") + " y))");
  assert.deepEqual(directionShortcut(fromHtml("(((x))"), 6).cell, [T("("), D("x")]);
});

test("plain text brackets a direction; the words said leave it out", () => {
  const cell = fromHtml("Hello " + DIR("beat") + " world, " + DIR("smile") + "<br>" + DIR("pause") + "<br>end" + DIR("x") + ".");
  assert.equal(toPlainText(cell), "Hello (beat) world, (smile)\n(pause)\nend(x).");
  assert.equal(spokenText(cell), "Hello world, \n\nend.");
  assert.equal(toPlainText([D("a "), D("b", { b: true })]), "(a b)");
  assert.equal(spokenText([D("only")]), "");
  assert.equal(spokenText([T("a"), D("x"), T("b")]), "a b");
});

test("Markdown writes one as the script prints it, in italics; the .md table in the typing notation", () => {
  const cell = fromHtml("Hello " + DIR("beat") + " world");
  assert.equal(toMarkdown(cell), "Hello *(beat)* world");
  assert.equal(toMarkdown(fromHtml(DIR("a <strong>b</strong>"))), "*(a **b**)*");
  assert.equal(htmlToMarkdown("Hello " + DIR("beat") + " world"), "Hello ((beat)) world");
});

test("Word runs carry dir and a bracket each side", () => {
  const runs = toDocxRuns(fromHtml("Hi " + DIR("be<strong>at</strong>") + " on"));
  assert.deepEqual(runs.map((r) => [r.text, !!r.dir, !!r.b]), [
    ["Hi ", false, false], ["(", true, false], ["be", true, false], ["at", true, true], [")", true, false], [" on", false, false]
  ]);
  assert.ok(toDocxRuns(fromHtml("plain <em>x</em>")).every((r) => !("dir" in r)));
});

test("the teleprompter shows it in place but never as a word to hear", () => {
  const view = prompterSceneHtml(fromHtml("Hello " + DIR("look to camera two") + " world"));
  assert.equal(view.words, 2);
  assert.equal(view.html, '<span class="w">Hello</span> ' + DIR("look to camera two") + ' <span class="w">world</span>');
  assert.equal(prompterSceneHtml(fromHtml(DIR("beat"))).words, 0);
});

test("read time: a direction takes none", () => {
  const TEN = "one two three four five six seven eight nine ten";
  const s = migrateRows({ schema: 2, title: "R", wordsPerMinute: 150, rows: [
    { id: "r1", audioText: TEN },
    { id: "r2", audioText: TEN + " " + DIR("hold for a long, slow beat while the kettle boils") }
  ] });
  withState(s, () => {
    assert.equal(productionReaders.wordCount(s.rows[1].audioText), 10);
    assert.equal(rowSeconds(s.rows[0], s, productionReaders), 4);
    assert.equal(rowSeconds(s.rows[1], s, productionReaders), 4);
  });
});

test("merge: a direction made on one side and words changed on the other both land", () => {
  const base = "Hello beat and then more words";
  const mine = toHtml(toggleDirection(fromHtml(base), 6, 10));
  const theirs = "Hello beat and then even more words";
  const got = mergeCells(fromHtml(base), fromHtml(mine), fromHtml(theirs));
  assert.equal(got.conflict, false);
  assert.equal(got.markConflicts, 0);
  assert.equal(toHtml(got.cell), "Hello " + DIR("beat") + " and then even more words");
  const both = mergeCells(fromHtml(base), fromHtml(mine), fromHtml(mine));
  assert.equal(toHtml(both.cell), mine);
  const off = mergeCells(fromHtml(mine), fromHtml(base), fromHtml(mine));
  assert.equal(toHtml(off.cell), base);
});

test("mergeStates carries a direction through the document merge", () => {
  const doc = (audio) => migrateRows({ schema: 2, title: "M", docId: "d" + "a".repeat(32), rows: [{ id: "r1", audioText: audio, visualText: "" }] });
  const base = doc("Hello beat and then more words");
  const mine = doc("Hello " + DIR("beat") + " and then more words");
  const theirs = doc("Hello beat and then even more words");
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.rows[0].audioText, "Hello " + DIR("beat") + " and then even more words");
  assert.equal(out.comments.length, 0, "no conflict card");
});

test("find & replace inside a direction keeps the new words in it", () => {
  const html = "Say it " + DIR("slow beat") + " now";
  const out = replaceInHtml(html, "slow", "long", -1, false);
  assert.equal(out.changed, 1);
  assert.equal(out.html, "Say it " + DIR("long beat") + " now");
});

test("the clipboard: the HTML keeps it; the plain text and the Visual column get it bracketed", () => {
  const cell = fromHtml("Hi " + DIR("beat") + " on");
  const out = clipboardOfCell(sliceCell(cell, 0, cellLength(cell)));
  assert.equal(out.html, "Hi " + DIR("beat") + " on");
  assert.equal(out.text, "Hi (beat) on");
  assert.deepEqual(flattenDirections(fromHtml(DIR("hold the " + tagSpan("prop", "Mug", "mug")))),
    [T("(hold the "), T("mug", { tag: "t:prop:Mug" }), T(")")]);
});

test("coming in: ((words)) becomes one; the brackets an export printed round one go", () => {
  assert.deepEqual(importDirections(fromHtml("A ((beat)) b ((smile)) c (aside)")),
    [T("A "), D("beat"), T(" b "), D("smile"), T(" c (aside)")]);
  assert.deepEqual(importDirections(fromHtml("A " + DIR("(beat)") + " b")), [T("A "), D("beat"), T(" b")]);
  assert.equal(audioDirectionsHtml("plain (words)"), "plain (words)", "left exactly as read");
});

function directionDoc() {
  return migrateRows({
    schema: 2, title: "Directions", wordsPerMinute: 150,
    rows: [
      { id: "r1", visualText: "Host", audioText: "Welcome back. " + DIR("beat") + " Today, the kettle.", status: "todo" },
      { id: "r2", visualText: "Wide", audioText: "Pour it " + DIR("slowly") + ".", status: "todo" }
    ]
  });
}

test(".splitpage carries it as it is", () => {
  const s = directionDoc();
  const back = migrateRows(parseSplitpageFile(buildSplitpageFile(exportDocumentOf(s))));
  assert.equal(back.rows[0].audioText, s.rows[0].audioText);
  assert.equal(back.rows[1].audioText, s.rows[1].audioText);
});

test(".md: the table shows ((beat)), an untouched file reopens unchanged, a hand edit keeps its directions", async () => {
  const s = directionDoc();
  const md = withState(s, () => buildMarkdownProject(exportDocumentOf(s)));
  assert.ok(md.includes("| Welcome back. ((beat)) Today, the kettle. |"), "the table cell");
  loadTestDocument(s);
  try {
    const same = await applyMarkdownProject(parseMarkdownProject(md), { noAsk: true });
    assert.equal(same.rows[0].audioText, s.rows[0].audioText);
    assert.equal(same.rows[1].audioText, s.rows[1].audioText);
    const edited = md.replace("Pour it ((slowly)).", "Pour it ((very slowly)), then ((smile)).");
    const back = await applyMarkdownProject(parseMarkdownProject(edited), { noAsk: true });
    assert.equal(back.rows[1].audioText, "Pour it " + DIR("very slowly") + ", then " + DIR("smile") + ".");
  } finally {
    loadTestDocument(null);
  }
});

test("narration export: directions in by default, as (beat); left out when switched off", () => {
  withState(directionDoc(), () => {
    assert.equal(buildNarrationText(liveDoc(), { directions: true }),
      "Directions\n\nWelcome back. (beat) Today, the kettle.\n\nPour it (slowly).\n");
    assert.equal(buildNarrationText(liveDoc(), { directions: false }),
      "Directions\n\nWelcome back. Today, the kettle.\n\nPour it.\n");
    const only = migrateRows({ schema: 2, title: "O", rows: [{ id: "a", audioText: DIR("beat") }, { id: "b", audioText: "Said." }] });
    withState(only, () => {
      assert.equal(narrationRows(liveDoc(), { directions: true }).length, 2);
      assert.equal(narrationRows(liveDoc(), { directions: false }).length, 1, "a scene that is only a direction has no narration");
    });
  });
});

async function documentXml(bytes) {
  const zip = await zipRead(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
  return new TextDecoder().decode(await zip.get("word/document.xml"));
}

test("narration .docx: a direction in its own style, or not there at all", async () => {
  const [on, off] = withState(directionDoc(), () => [buildNarrationDocx(liveDoc(), { directions: true }), buildNarrationDocx(liveDoc(), { directions: false })]);
  const withDirs = await documentXml(on);
  assert.match(withDirs, /<w:rStyle w:val="SplitpageDirection"\/><w:i\/><w:color w:val="6B6A65"\/><\/w:rPr><w:t xml:space="preserve">\(<\/w:t>/);
  assert.ok(withDirs.includes(">beat<"));
  const without = await documentXml(off);
  assert.ok(!without.includes("beat") && !without.includes("slowly") && !without.includes("SplitpageDirection"));
  assert.ok(without.includes(">Pour it<") && without.includes(">.<"));
});

test("a Splitpage .docx reopens with its directions as directions; ((…)) in a Word file's Audio is one too", async () => {
  const s = directionDoc();
  const bytes = withState(s, () => buildDocx(...liveWithAssets()));
  const parsed = await docxToRows(new File([bytes], "script.docx"));
  assert.equal(parsed.rows[0].audioText, s.rows[0].audioText);
  assert.equal(parsed.rows[1].audioText, s.rows[1].audioText);

  const W = (body) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + "</w:body></w:document>";
  const p = (t) => '<w:p><w:r><w:t xml:space="preserve">' + t + "</w:t></w:r></w:p>";
  const foreign = zipWrite([{ name: "word/document.xml", data: strBytes(W(p("Hello ((beat)) world.") + p("(A wide shot of the lake.)") + p("Then (quietly) on."))) }]);
  const rows = (await docxToRows(new File([foreign], "mine.docx"))).rows;
  assert.equal(rows[0].audioText, "Hello " + DIR("beat") + " world.");
  assert.equal(rows[1].visualText, "(A wide shot of the lake.)");
  assert.equal(rows[1].audioText, "Then (quietly) on.", "single brackets are prose");
});

test("the other exports print it as (beat)", () => {
  withState(directionDoc(), () => {
    assert.ok(toMarkdownDoc(exportDocumentOf(S.state)).includes("Welcome back. *(beat)* Today, the kettle."));
    assert.ok(buildCsv(liveDoc()).includes("Welcome back. (beat) Today, the kettle."));
  });
});

test("migrateRows keeps a direction as it is and reading it twice changes nothing", () => {
  const s = directionDoc();
  const again = migrateRows(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(again.rows, s.rows);
  assert.equal(projection(fromHtml(s.rows[0].audioText)), "Welcome back. beat Today, the kettle.");
});
