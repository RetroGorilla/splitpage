import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { applyStepsLive, undo, redo, undoSizes, flushEdits } = await import("../js/12a-undo.js");
const { invertSteps } = await import("../js/04c-doc-model.js");
const { rememberCellSelection, placeEditorSelection, cellSelection } = await import("../features/editing/cell-selection.ts");
const { editorSelection } = await import("../legacy/editor-bridge.ts");
const { liveSession } = await import("../legacy/session-bridge.ts");
const { sanitizeHtml } = await import("../legacy/richtext.ts");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 9_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const SHA = "cd".repeat(32);
const PICTURE = '<img class="comment-img" data-blob="' + SHA + '">';
const CARD = sanitizeHtml('<a class="video-embed-card" href="https://youtu.be/abc" contenteditable="false">Watch</a>');

let opened = 0;
async function open(audio) {
  window.__hostedTest.setSession({ role: "edit", docId: null });
  const doc = { schema: 2, title: "Undo media", rows: [{ id: "r1", visualText: "", audioText: audio, status: "todo" }], comments: [] };
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(doc)))], "undo-media-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

const cell = () => currentDocument().rows[0].audioText;
const cellEl = () => document.querySelector('#rows .cell-editable[data-id="r1"][data-field="audioText"]');

function store(html) {
  const el = cellEl();
  el.focus();
  el.innerHTML = html;
  el.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "" }));
  flushEdits();
  clock += 10_000;
}

beforeEach(() => { clock += 10_000; });

for (const [name, media] of [["picture", PICTURE], ["video card", CARD]]) {
  test("adding a " + name + " is an undo step of its own: undo takes it away, redo puts it back", async () => {
    await open("Hello");
    store("Hello world");
    const before = undoSizes().undo;
    store("Hello world" + media);
    assert.equal(cell(), "Hello world" + media);
    assert.equal(undoSizes().undo, before + 1, "a media-only change is content, not cosmetic");
    const generation = liveSession().generation();
    undo();
    assert.equal(cell(), "Hello world");
    assert.equal(liveSession().generation(), generation + 1, "one generation advance per undo");
    redo();
    assert.equal(cell(), "Hello world" + media);
    undo();
    undo();
    assert.equal(cell(), "Hello");
    redo();
    redo();
    assert.equal(cell(), "Hello world" + media);
  });

  test("undoing a text edit keeps a " + name + " that sits beside it", async () => {
    await open("Hello");
    store("Hello " + media);
    store("Hello world " + media);
    undo();
    assert.equal(cell(), "Hello " + media);
    redo();
    assert.equal(cell(), "Hello world " + media);
  });

  test("a three-way undo over a cell that gained a " + name + " since keeps it", () => {
    const step = { op: "rowField", rowId: "r1", key: "audioText", before: "alpha bravo charlie", after: "alpha BRAVO charlie" };
    const live = { title: "T", rows: [{ id: "r1", visualText: "", audioText: "alpha BRAVO charlie " + media, status: "todo" }], comments: [], productionTags: [], people: [], brollShots: [] };
    assert.deepEqual(applyStepsLive(live, invertSteps([step])), { ok: true });
    assert.equal(live.rows[0].audioText, "alpha bravo charlie " + media);
    assert.deepEqual(applyStepsLive(live, [step]), { ok: true });
    assert.equal(live.rows[0].audioText, "alpha BRAVO charlie " + media);
  });

  test("a three-way undo over a " + name + " the step itself added keeps text typed since", () => {
    const step = { op: "rowField", rowId: "r1", key: "audioText", before: "alpha bravo", after: "alpha " + media + " bravo" };
    const live = { title: "T", rows: [{ id: "r1", visualText: "", audioText: "alpha " + media + " bravo charlie", status: "todo" }], comments: [], productionTags: [], people: [], brollShots: [] };
    assert.deepEqual(applyStepsLive(live, invertSteps([step])), { ok: true });
    assert.equal(live.rows[0].audioText, "alpha bravo charlie");
  });
}

test("a remembered caret after a picture comes back at the same place", async () => {
  await open("ab");
  store("ab " + PICTURE + " cd");
  const el = cellEl();
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const at = cellSelection(el);
  assert.equal(at.from, 7, "three letters, the picture and three letters");
  const taken = rememberCellSelection(editorSelection(), el);
  assert.equal(taken.head, 7);
  sel.removeAllRanges();
  assert.equal(placeEditorSelection(editorSelection(), document.querySelector("#rows")), el);
  assert.deepEqual(cellSelection(el), { from: 7, to: 7 });
});
