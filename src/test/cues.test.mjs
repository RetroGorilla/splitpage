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
  __init as initTags, closeCueNames, cueEditPairs, healTagRegistry, productionEntries, removeTag, renameTag, tagsInField
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
  assert.deepEqual(normalizeCell([C("SFX:"), T(" door")]), [C("SFX: door")]);
  assert.deepEqual(normalizeCell([C("SFX: a\nb")]), [C("SFX: a"), T("\nb")]);
  assert.deepEqual(normalizeCell([C("door slam")]), [T("door slam")]);
  assert.deepEqual(normalizeCell([T("x "), C("SFX: a")]), [T("x SFX: a")]);
  assert.deepEqual(normalizeCell([C("  music : theme")]), [C("  music : theme")]);
  const cell = [C("SFX: "), C("door", { b: true, cmt: ["c1"] })];
  assert.equal(toHtml(cell), CUE('SFX: <span class="cmt-anchor" data-cmt="c1"><strong>door</strong></span>'));
});

test("typing the colon after SFX or Music at a line's start makes the line a cue", () => {
  const cell = fromHtml("Hello.<br>SFX:");
  const got = cueShortcut(cell, cellLength(cell));
  assert.equal(toHtml(got), "Hello.<br>" + CUE("SFX:"));
  const more = insertText(got, cellLength(got), " door slam");
  assert.equal(toHtml(more), "Hello.<br>" + CUE("SFX: door slam"));
  const br = breakLine(more, cellLength(more), cellLength(more));
  const next = insertText(br.cell, br.pos, "Next.");
  assert.equal(toHtml(next), "Hello.<br>" + CUE("SFX: door slam") + "<br>Next.<br>");
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
    assert.deepEqual(tagsInField(CUE("SFX:")), []);
  });
});

test("an edited cue keeps its item: renamed in place with its status, no entry left per wording", () => {
  const s = cueDoc();
  s.rows.push({ id: "r3", visualText: "", audioText: "", status: "todo" });
  const sound = () => s.productionTags.filter((t) => t.cat === "sound").map((t) => t.name + "/" + t.status).sort();
  withState(s, () => {
    healTagRegistry();
    s.rows[2].audioText = CUE("Music: slow");
    healTagRegistry();
    s.rows[2].audioText = CUE("Music: slow piano");
    healTagRegistry();
    s.rows[2].audioText = CUE("Music: slow piano intro");
    healTagRegistry();
    assert.deepEqual(sound(), ["door slam/needed", "slow piano intro/needed", "upbeat intro/needed"]);
    const id = s.productionTags.find((t) => t.name === "slow piano intro").id;
    s.productionTags.find((t) => t.name === "slow piano intro").status = "have";
    s.productionTags.find((t) => t.name === "slow piano intro").notes = "the Rhodes take";
    s.rows[2].audioText = CUE("Music: slow piano intros");
    healTagRegistry();
    assert.deepEqual(sound(), ["door slam/needed", "slow piano intros/have", "upbeat intro/needed"]);
    const e = s.productionTags.find((t) => t.name === "slow piano intros");
    assert.equal(e.id, id, "the same entry");
    assert.equal(e.notes, "the Rhodes take");
    assert.deepEqual(productionEntries().filter((x) => x.cat.id === "sound").map((x) => [x.name, x.orphaned]).sort(),
      [["door slam", false], ["slow piano intros", false], ["upbeat intro", false]]);
  });
});

test("an edited cue leaves the item alone while its old name is still in the script, or the new one is tracked", () => {
  const s = cueDoc();
  s.rows[1].audioText = CUE("SFX: door slam");
  withState(s, () => {
    healTagRegistry();
    s.productionTags.find((t) => t.name === "door slam").status = "have";
    s.rows[1].audioText = CUE("SFX: door slams");
    healTagRegistry();
    assert.deepEqual(s.productionTags.filter((t) => t.cat === "sound").map((t) => t.name + "/" + t.status).sort(),
      ["door slam/have", "door slams/needed", "upbeat intro/needed"]);
  });
  const v = cueDoc();
  v.rows[0].visualText = 'Kitchen <span class="tag-anchor" data-tag-cat="sound" data-tag-name="door slam" contenteditable="false">door slam</span>';
  withState(v, () => {
    healTagRegistry();
    v.rows[0].audioText = "Welcome back.<br>" + CUE("SFX: door bang");
    healTagRegistry();
    assert.deepEqual(v.productionTags.filter((t) => t.cat === "sound").map((t) => t.name).sort(),
      ["door bang", "door slam", "upbeat intro"]);
  });
  const t = cueDoc();
  withState(t, () => {
    healTagRegistry();
    t.rows[1].audioText = CUE("Music: door slam");
    t.rows[0].audioText = "Welcome back.";
    healTagRegistry();
    t.rows[0].audioText = "Welcome back.<br>" + CUE("SFX: upbeat intro");
    healTagRegistry();
    assert.deepEqual(t.productionTags.filter((x) => x.cat === "sound").map((x) => x.name).sort(), ["door slam", "upbeat intro"]);
  });
});

function twoCueDoc() {
  return migrateRows({ schema: 2, title: "Two cues", wordsPerMinute: 150, rows: [
    { id: "r1", visualText: "", audioText: CUE("SFX: door slam") + "<br>Then.<br>" + CUE("SFX: kettle whistle") },
    { id: "r2", visualText: "", audioText: CUE("Music: theme") }
  ] });
}
const soundItems = (s) => s.productionTags.filter((t) => t.cat === "sound").map((t) => t.name + "/" + t.status).sort();

test("one cue deleted and another edited in the same cell: the edited one keeps its item (#282)", () => {
  for (const [label, edited, keep, gone] of [
    ["the first deleted, the second edited", "Then.<br>" + CUE("SFX: kettle whistling"), "kettle whistle", "door slam"],
    ["the first edited, the second deleted", CUE("SFX: door slams") + "<br>Then.", "door slam", "kettle whistle"]
  ]) {
    const s = twoCueDoc();
    withState(s, () => {
      healTagRegistry();
      const kept = s.productionTags.find((t) => t.name === keep);
      Object.assign(kept, { status: "have", notes: "the good take" });
      s.productionTags.find((t) => t.name === gone).status = "ordered";
      s.rows[0].audioText = edited;
      healTagRegistry();
      const newName = keep === "kettle whistle" ? "kettle whistling" : "door slams";
      assert.deepEqual(soundItems(s), [gone + "/ordered", newName + "/have", "theme/needed"].sort(), label);
      const e = s.productionTags.find((t) => t.name === newName);
      assert.equal(e.id, kept.id, label + ": the same entry");
      assert.equal(e.notes, "the good take", label);
      assert.deepEqual(productionEntries().filter((x) => x.orphaned).map((x) => x.name), [gone], label);
    });
  }
});

test("both cues in a cell edited at once: each keeps its own item, by its line", () => {
  const s = twoCueDoc();
  withState(s, () => {
    healTagRegistry();
    s.productionTags.find((t) => t.name === "door slam").status = "have";
    s.rows[0].audioText = CUE("SFX: door slams") + "<br>Then.<br>" + CUE("SFX: kettle whistles");
    healTagRegistry();
    assert.deepEqual(soundItems(s), ["door slams/have", "kettle whistles/needed", "theme/needed"]);
  });
});

test("a cue deleted beside an edit that could be either cue's: no rename, a new item (#282)", () => {
  const s = migrateRows({ schema: 2, title: "Ambiguous", wordsPerMinute: 150, rows: [
    { id: "r1", visualText: "", audioText: CUE("Music: slow") + "<br>" + CUE("Music: slow piano") }
  ] });
  withState(s, () => {
    healTagRegistry();
    s.productionTags.forEach((t) => { t.status = "have"; });
    s.rows[0].audioText = CUE("Music: slow piano intro");
    healTagRegistry();
    assert.deepEqual(soundItems(s), ["slow piano intro/needed", "slow piano/have", "slow/have"]);
  });
  const t = twoCueDoc();
  withState(t, () => {
    healTagRegistry();
    t.rows[0].audioText = "Then.<br>" + CUE("SFX: thunder");
    healTagRegistry();
    assert.deepEqual(soundItems(t), ["door slam/needed", "kettle whistle/needed", "theme/needed", "thunder/needed"]);
  });
});

test("cueEditPairs: which old cue name each new one is taken as an edit of", () => {
  assert.deepEqual(cueEditPairs(["a"], ["b"]), [["a", "b"]], "one out, one in: always an edit");
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle"], ["kettle whistling"]), [["kettle whistle", "kettle whistling"]]);
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle"], ["door slams"]), [["door slam", "door slams"]]);
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle"], ["thunder"]), [], "like neither: no rename");
  assert.deepEqual(cueEditPairs(["slow", "slow piano"], ["slow piano intro"]), [], "like both: no rename");
  assert.deepEqual(cueEditPairs(["ab", "cd", "ef"], ["xy", "cd"]), [], "a cue gone and nothing close: no rename");
  assert.deepEqual(cueEditPairs(["door slam", "kettle whistle", "theme"], ["door slams", "kettle whistles"]),
    [["door slam", "door slams"], ["kettle whistle", "kettle whistles"]]);
  assert.deepEqual(cueEditPairs(["x", "y"], ["p", "q"]), [["x", "p"], ["y", "q"]], "as many in as out: in order, as before");
  assert.deepEqual(cueEditPairs(["door slam", "door slam"], ["door slams"]), [["door slam", "door slams"]]);
  assert.deepEqual(cueEditPairs(["a", "b"], ["a", "b", "c"]), []);
  assert.equal(closeCueNames("Pianno intro", "piano intro"), true, "a typo fixed in the middle");
  assert.equal(closeCueNames("door slam", "door bang"), true);
  assert.equal(closeCueNames("door slam", "upbeat intro"), false);
});

test("seeded: cueEditPairs pairs exactly as the old positional pairing wherever as many names went as came", () => {
  const oldPairs = (before, after) => {
    const gone = before.filter((n) => !after.includes(n));
    const came = after.filter((n) => !before.includes(n));
    const out = [];
    for (let i = 0; i < gone.length && i < came.length; i++) out.push([gone[i], came[i]]);
    return out;
  };
  const NAMES = ["door slam", "door slams", "kettle whistle", "kettle whistling", "theme", "thunder", "slow", "slow piano"];
  let s = 7;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const draw = () => Array.from({ length: 1 + Math.floor(r() * 3) }, () => NAMES[Math.floor(r() * NAMES.length)]);
  let compared = 0;
  for (let i = 0; i < 2000; i++) {
    const before = draw();
    const after = r() < 0.5 ? before.map((n) => (r() < 0.5 ? n : NAMES[Math.floor(r() * NAMES.length)])) : draw();
    const got = cueEditPairs(before, after);
    const msg = JSON.stringify([before, after]);
    const gone = before.filter((n) => !after.includes(n));
    const came = after.filter((n) => !before.includes(n));
    if (gone.length === came.length) {
      assert.deepEqual(got, oldPairs(before, after), msg);
      compared++;
    } else {
      const unique = (l) => new Set(l).size === l.length;
      assert.ok(unique(got.map((p) => p[0])) && unique(got.map((p) => p[1])), msg);
      if (new Set(gone).size > 1 || new Set(came).size > 1) {
        for (const [g, c] of got) assert.ok(closeCueNames(g, c), msg + " paired names that are not close");
      }
    }
    for (const [g, c] of got) assert.ok(gone.includes(g) && came.includes(c), msg);
  }
  assert.ok(compared > 300, "compared " + compared);
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

test("a tag or a direction on a cue line is not part of its name, and a rename leaves both", () => {
  const tag = (cat, name) => `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
  const dir = (t) => `<span class="stage-dir">${t}</span>`;
  const line = CUE("SFX: door " + tag("prop", "slam") + " " + dir("loud"));
  assert.deepEqual(cuesInCell(fromHtml(line)).map((c) => c.name), ["door"]);
  const renamed = toHtml(editCues(fromHtml(line), (n) => n === "door", "door bang"));
  assert.equal(renamed, CUE("SFX: door bang " + tag("prop", "slam") + " " + dir("loud")));
  assert.deepEqual(cuesInCell(fromHtml(renamed)).map((c) => c.name), ["door bang"]);

  const split = CUE("SFX: big " + tag("prop", "slam") + " door");
  assert.deepEqual(cuesInCell(fromHtml(split)).map((c) => c.name), ["big door"]);
  assert.equal(toHtml(editCues(fromHtml(split), () => true, "huge door")), CUE("SFX: huge door " + tag("prop", "slam")));

  const allTag = CUE("Music: " + tag("sound", "intro sting"));
  assert.deepEqual(cuesInCell(fromHtml(allTag)).map((c) => c.name), [""]);
  assert.deepEqual(tagsInField(allTag).map((t) => [t.catId, t.name]), [["sound", "intro sting"]]);
  assert.equal(toHtml(editCues(fromHtml(allTag), () => true, "x")), allTag);
});

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
