/* Sound cues in the Audio column (#219): the `cue` mark of the document
 * model (04c-doc-model.js) and everything that reads it.
 *
 * A cue is a whole line of an Audio cell starting "SFX:" or "Music:",
 * carrying cue. It is stored as <span class="audio-cue">, shown small and
 * in the Music/SFX colour, left out of the teleprompter, the read time and
 * the narration export, written as its own styled line by the script
 * exports, and listed as a Music/SFX item in the Production panel. The
 * live half — typing the colon, its Ctrl+Z, the look — is browser suite
 * 219-sound-cues.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { __init as initSceneStatus, rowSeconds, wordCount } from "../js/01-scene-status.js";
import { migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { sanitizeHtml } from "../js/04-richtext.js";
import {
  breakLine, cellLength, cueShortcut, cuesInCell, deleteRange, editCues, flattenCues, fromHtml, importCues,
  insertText, mergeCells, normalizeCell, spokenText, toDocxRuns, toHtml, toMarkdown, toPlainText, withoutCues
} from "../js/04c-doc-model.js";
import {
  __init as initTags, healTagRegistry, productionEntries, removeTag, renameTag, tagsInField
} from "../js/07-production-tags.js";
import { zipRead } from "../js/14-export.js";
import { __init as initDocx, audioDirectionsHtml, buildDocx, buildNarrationText } from "../js/15-docx.js";
import { prompterSceneHtml, trimPrompterCell } from "../js/20-teleprompter.js";

initTags();
initSceneStatus();
initDocx();

const T = (text, marks) => ({ text, marks: marks || {} });
const C = (text, marks) => ({ text, marks: Object.assign({ cue: true }, marks || {}) });
const CUE = (inner) => `<span class="audio-cue">${inner}</span>`;

function withState(s, fn) {
  const was = S.state;
  S.state = s;
  try { return fn(s); } finally { S.state = was; }
}

function cueDoc() {
  return migrateRows({ schema: 2, title: "Cues", wordsPerMinute: 150, rows: [
    { id: "r1", visualText: "Kitchen", audioText: "Welcome back.<br>" + CUE("SFX: door slam") + "<br>Today, the kettle." },
    { id: "r2", visualText: "", audioText: CUE("Music: upbeat intro") }
  ] });
}

/* ---- the model ---- */

test("stored as a span round the whole line, read back as the cue mark, a fixed point of the sanitiser", () => {
  const html = "Hello.<br>" + CUE("SFX: door slam") + "<br>On.";
  const cell = fromHtml(html);
  assert.deepEqual(cell, [T("Hello.\n"), C("SFX: door slam"), T("\nOn.")]);
  assert.equal(toHtml(cell), html);
  assert.equal(sanitizeHtml(html), html);
  assert.deepEqual(fromHtml(toHtml(cell)), normalizeCell(cell));
  assert.equal(sanitizeHtml('<span class="audio-cue x" style="color:red" onclick="x()">SFX: a</span>'), CUE("SFX: a"));
});

test("the mark covers whole lines that start with the keyword, and only those", () => {
  /* part of a line: the rest of it joins */
  assert.deepEqual(normalizeCell([C("SFX:"), T(" door")]), [C("SFX: door")]);
  /* a line break is never in one, and the next line is not */
  assert.deepEqual(normalizeCell([C("SFX: a\nb")]), [C("SFX: a"), T("\nb")]);
  /* its keyword gone, it is words again */
  assert.deepEqual(normalizeCell([C("door slam")]), [T("door slam")]);
  assert.deepEqual(normalizeCell([T("x "), C("SFX: a")]), [T("x SFX: a")]);
  /* any case, spaces round the keyword */
  assert.deepEqual(normalizeCell([C("  music : theme")]), [C("  music : theme")]);
  /* formatting and a comment inside keep their own marks, one span */
  const cell = [C("SFX: "), C("door", { b: true, cmt: ["c1"] })];
  assert.equal(toHtml(cell), CUE('SFX: <span class="cmt-anchor" data-cmt="c1"><strong>door</strong></span>'));
});

test("typing the colon after SFX or Music at a line's start makes the line a cue", () => {
  const cell = fromHtml("Hello.<br>SFX:");
  const got = cueShortcut(cell, cellLength(cell));
  assert.equal(toHtml(got), "Hello.<br>" + CUE("SFX:"));
  /* typing on is more of the cue */
  const more = insertText(got, cellLength(got), " door slam");
  assert.equal(toHtml(more), "Hello.<br>" + CUE("SFX: door slam"));
  /* Enter at its end starts an ordinary line */
  const br = breakLine(more, cellLength(more), cellLength(more));
  const next = insertText(br.cell, br.pos, "Next.");
  assert.equal(toHtml(next), "Hello.<br>" + CUE("SFX: door slam") + "<br>Next.<br>");
  /* Music too, any case; a colon in the middle of a line that was already written */
  const mid = fromHtml("music: big theme");
  assert.equal(toHtml(cueShortcut(mid, 6)), CUE("music: big theme"));
  assert.equal(toHtml(cueShortcut(fromHtml("  Sfx:"), 6)), CUE("  Sfx:"));
});

test("mid-sentence, other words, or already a cue: nothing", () => {
  assert.equal(cueShortcut(fromHtml("Cue the SFX:"), 12), null);
  assert.equal(cueShortcut(fromHtml("VFX:"), 4), null);
  assert.equal(cueShortcut(fromHtml("SFXs:"), 5), null);
  assert.equal(cueShortcut(fromHtml("SFX"), 3), null, "no colon typed");
  assert.equal(cueShortcut(fromHtml(CUE("SFX: a")), 4), null);
});

test("readers: plain text keeps it as a line, the words said leave it out", () => {
  const cell = fromHtml("Welcome back.<br>" + CUE("SFX: door slam") + "<br>Today.");
  assert.equal(toPlainText(cell), "Welcome back.\nSFX: door slam\nToday.");
  assert.equal(spokenText(cell), "Welcome back.\nToday.");
  assert.equal(toPlainText(cell, { cues: "omit" }), "Welcome back.\nToday.");
  assert.equal(toHtml(withoutCues(fromHtml(CUE("Music: a") + "<br>Hi"))), "Hi");
  assert.equal(toHtml(withoutCues(fromHtml("Hi<br>" + CUE("Music: a")))), "Hi");
  assert.equal(toHtml(withoutCues(fromHtml(CUE("Music: a")))), "");
  assert.deepEqual(cuesInCell(cell), [{ kind: "sfx", name: "door slam", text: "SFX: door slam" }]);
});

test("Markdown sets it in italics on its own line; Word runs carry cue", () => {
  const cell = fromHtml("Hi.<br>" + CUE("SFX: door") + "<br>On.");
  assert.equal(toMarkdown(cell), "Hi.\n*SFX: door*\nOn.");
  const runs = toDocxRuns(cell);
  assert.deepEqual(runs.map((r) => [r.text, !!r.cue]), [["Hi.", false], ["\n", false], ["SFX: door", true], ["\n", false], ["On.", false]]);
});

test("coming in: a line starting SFX: or Music: in the Audio column becomes one; mid-line it does not", () => {
  assert.equal(toHtml(importCues(fromHtml("a<br>sfx: boom<br>b SFX: x"))), "a<br>" + CUE("sfx: boom") + "<br>b SFX: x");
  assert.equal(audioDirectionsHtml("Hi<br>Music: theme"), "Hi<br>" + CUE("Music: theme"));
  assert.equal(audioDirectionsHtml("Nothing here"), "Nothing here");
});

test("the Visual column has none: a pasted one is its words", () => {
  assert.deepEqual(flattenCues(fromHtml(CUE("SFX: a"))), [T("SFX: a")]);
});

test("merge: a cue made on one side and words changed on the other both land", () => {
  const base = "Hi.<br>SFX: door<br>On.";
  const mine = "Hi.<br>" + CUE("SFX: door") + "<br>On.";
  const got = mergeCells(fromHtml(base), fromHtml(mine), fromHtml("Hi there.<br>SFX: door<br>On."));
  assert.equal(got.conflict, false);
  assert.equal(toHtml(got.cell), "Hi there.<br>" + CUE("SFX: door") + "<br>On.");
  /* their words added to the cue line are in it */
  const longer = mergeCells(fromHtml(base), fromHtml(mine), fromHtml("Hi.<br>SFX: door slam<br>On."));
  assert.equal(toHtml(longer.cell), "Hi.<br>" + CUE("SFX: door slam") + "<br>On.");
});

test("mergeStates carries a cue through the document merge", () => {
  const doc = (audio) => migrateRows({ schema: 2, title: "M", docId: "d" + "a".repeat(32), rows: [{ id: "r1", audioText: audio, visualText: "" }] });
  const base = doc("Hello.<br>SFX: door<br>More words");
  const mine = doc("Hello.<br>" + CUE("SFX: door") + "<br>More words");
  const theirs = doc("Hello.<br>SFX: door<br>Even more words");
  const out = mergeStates(base, mine, theirs).merged;
  assert.equal(out.rows[0].audioText, "Hello.<br>" + CUE("SFX: door") + "<br>Even more words");
  assert.equal(out.comments.length, 0, "no conflict card");
});

/* ---- where it shows ---- */

test("the teleprompter never shows one, and voice follow has no word of it", () => {
  const cell = trimPrompterCell(withoutCues(fromHtml("Hello.<br>" + CUE("SFX: door slam") + "<br>World.")));
  const view = prompterSceneHtml(cell);
  assert.equal(view.words, 2);
  assert.ok(!view.html.includes("door") && !view.html.includes("audio-cue"));
});

test("read time: a cue takes none", () => {
  const TEN = "one two three four five six seven eight nine ten";
  const s = migrateRows({ schema: 2, title: "R", wordsPerMinute: 150, rows: [
    { id: "r1", audioText: TEN },
    { id: "r2", audioText: TEN + "<br>" + CUE("SFX: a long and winding rumble of thunder over the hills") }
  ] });
  withState(s, () => {
    assert.equal(wordCount(s.rows[1].audioText), 10);
    assert.equal(rowSeconds(s.rows[0]), rowSeconds(s.rows[1]));
  });
});

test("the Production panel lists it under Music/SFX, with the tags of the same name, tracked by the registry", () => {
  const s = cueDoc();
  s.rows[0].visualText = 'Kitchen <span class="tag-anchor" data-tag-cat="sound" data-tag-name="door slam" contenteditable="false">door slam</span>';
  withState(s, () => {
    healTagRegistry();
    const sound = productionEntries().filter((e) => e.cat.id === "sound");
    assert.deepEqual(sound.map((e) => [e.name, e.mentions.length]).sort(), [["door slam", 2], ["upbeat intro", 1]]);
    assert.ok(s.productionTags.some((t) => t.cat === "sound" && t.name === "upbeat intro" && t.status === "needed"));
    /* a bare "SFX:" names nothing */
    assert.deepEqual(tagsInField(CUE("SFX:")), []);
  });
});

test("renaming the item rewrites the cue's words; removing it makes the line plain words", () => {
  const s = cueDoc();
  withState(s, () => {
    healTagRegistry();
    renameTag("sound", "upbeat intro", "Main theme");
    assert.equal(s.rows[1].audioText, CUE("Music: Main theme"));
    assert.equal(removeTag("sound", "door slam"), 1);
    assert.equal(s.rows[0].audioText, "Welcome back.<br>SFX: door slam<br>Today, the kettle.");
  });
  assert.equal(toHtml(editCues(fromHtml(CUE("Music:theme")), () => true, "Big theme")), CUE("Music: Big theme"));
});

/* ---- exports ---- */

test("narration export leaves cues out, directions or not", () => {
  withState(cueDoc(), () => {
    assert.equal(buildNarrationText({ directions: true }), "Cues\n\nWelcome back.\nToday, the kettle.\n");
    assert.equal(buildNarrationText({ directions: false }), "Cues\n\nWelcome back.\nToday, the kettle.\n");
  });
});

test("the script .docx writes a cue in its own style, small and in the Music/SFX colour", async () => {
  const bytes = await withState(cueDoc(), () => buildDocx());
  const zip = await zipRead(bytes.buffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
  const xml = new TextDecoder().decode(await zip.get("word/document.xml"));
  assert.match(xml, /<w:rStyle w:val="SplitpageCue"\/><w:color w:val="AB413E"\/><w:sz w:val="18"\/><\/w:rPr><w:t xml:space="preserve">SFX: door slam<\/w:t>/);
  const styles = new TextDecoder().decode(await zip.get("word/styles.xml"));
  assert.ok(styles.includes('w:styleId="SplitpageCue"'));
});

test("migrateRows keeps a cue as it is, and deleting its keyword ends it", () => {
  const s = cueDoc();
  assert.equal(s.rows[0].audioText, "Welcome back.<br>" + CUE("SFX: door slam") + "<br>Today, the kettle.");
  assert.deepEqual(migrateRows(JSON.parse(JSON.stringify(s))).rows[0].audioText, s.rows[0].audioText);
  const cell = fromHtml(CUE("SFX: door slam"));
  assert.equal(toHtml(deleteRange(cell, 0, 4)), " door slam");
});
