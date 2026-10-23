import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../legacy/session-bridge.ts";
import { saveChanges } from "../legacy/save-bridge.ts";

window.Element.prototype.scrollBy = function () {};
window.Element.prototype.scrollIntoView = function () {};
await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { exportDocumentOf } = await import("../js/14b-export-kit.js");
const { buildSplitpageFile } = await import("../adapters/formats/project-file.ts");
const { maybeAutoTagShortcut } = await import("../js/07-production-tags.js");
const { maybeOpenPlainTag, closePlainTag, cancelPlainTag } = await import("../js/07b-plain-tags.js");
const { maybeCaptureBroll } = await import("../bootstrap/wiring/broll.ts");
const { pasteIntoCell } = await import("../js/05c-clipboard.js");
const { closeImportModal, openImportModal } = await import("../js/11-import.js");
const { undo, undoSizes, flushEdits } = await import("../js/12a-undo.js");
const { liveSession } = await import("../legacy/session-bridge.ts");
const writer = await import("../js/19-writer.js");
const { viewFlags } = await import("../legacy/preferences-bridge.ts");
const { openDocument } = await import("../legacy/transition-bridge.ts");

after(closeApp);

const realNow = Date.now;
let clock = 9_000_000;
Date.now = () => clock;
after(() => { Date.now = realNow; });

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fixture() {
  return {
    schema: 2,
    title: "Orphan records",
    rows: [
      { id: "r1", visualText: "Wide", audioText: "Grab the [Mug]", status: "todo" },
      { id: "r2", visualText: "prop: Kettle", audioText: "Sound", status: "ready" }
    ]
  };
}

function withBrollLine() {
  const doc = fixture();
  doc.rows.push({ id: "r3", visualText: "B-roll:", audioText: "Steam", status: "todo" });
  return doc;
}

let opened = 0;
async function open(make = fixture) {
  if (viewFlags().writerOpen()) writer.closeWriter();
  cancelPlainTag();
  const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows(make())))], "orphans-" + (++opened) + ".splitpage", { lastModified: opened });
  await openDocument({ kind: "file", file: file, handle: null, options: { skipSnapshot: true } });
  flushEdits();
}

const settle = () => new Promise((r) => setImmediate(r));
const row = (id) => currentDocument().rows.find((r) => r.id === id);
const cellOf = (id, field) => document.querySelector('#rows .cell-editable[data-id="' + id + '"][data-field="' + field + '"]');
const tagNames = () => currentDocument().productionTags.map((t) => t.cat + ":" + t.name);
const shotIds = () => currentDocument().brollShots.map((s) => s.id);

function lastText(el) {
  const walker = document.createTreeWalker(el, 4);
  let last = null;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

function caretAtEnd(el) {
  el.focus();
  const text = lastText(el);
  const r = document.createRange();
  r.setStart(text, text.data.length);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  return text;
}

function watch() {
  const seen = [];
  const stop = liveSession().subscribe((c) => seen.push(c));
  return { seen, stop };
}

function snapshot() {
  return { doc: JSON.stringify(currentDocument()), generation: liveSession().generation(), seq: saveChanges() };
}

function assertUntouched(before, seen) {
  assert.equal(JSON.stringify(currentDocument()), before.doc, "the document, its tag registry and its b-roll list are as they were");
  assert.equal(liveSession().generation(), before.generation);
  assert.equal(saveChanges(), before.seq);
  assert.deepEqual(seen, []);
}

async function asReviewer(fn) {
  window.__hostedTest.setSession({ role: "review", docId: "shared-doc" });
  try {
    return await fn();
  } finally {
    window.__hostedTest.setSession({ role: "edit", docId: null });
  }
}

function failingClock(fn) {
  const real = Date.prototype.toISOString;
  Date.prototype.toISOString = function () { throw new Error("no clock"); };
  try {
    return fn();
  } finally {
    Date.prototype.toISOString = real;
  }
}

function typeTagClose() {
  const el = cellOf("r1", "audioText");
  caretAtEnd(el);
  maybeAutoTagShortcut({ inputType: "insertText", data: "]" }, el);
}

function openPlainTag() {
  const el = cellOf("r2", "visualText");
  const text = caretAtEnd(el);
  const r = document.createRange();
  r.setStart(text, "prop:".length);
  r.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(r);
  maybeOpenPlainTag({ inputType: "insertText", data: ":" }, el);
  const tail = lastText(el);
  const end = document.createRange();
  end.setStart(tail, tail.data.length);
  end.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(end);
  return el;
}

function typeBrollMarker() {
  const el = cellOf("r3", "visualText");
  caretAtEnd(el);
  maybeCaptureBroll({ inputType: "insertText", data: ":" }, el);
}

beforeEach(() => { clock += 10_000; });

test("a typed [tag] writes its registry record in the same command as the tag: one generation, one publication declaring the registry, one undo step", async () => {
  await open();
  await settle();
  const generation = liveSession().generation();
  const sizes = undoSizes();
  const w = watch();
  try {
    typeTagClose();
  } finally {
    w.stop();
  }
  assert.match(row("r1").audioText, /tag-anchor/);
  assert.deepEqual(tagNames(), ["prop:Mug"]);
  assert.equal(liveSession().generation(), generation + 1);
  assert.equal(w.seen.length, 1);
  const change = w.seen[0];
  assert.equal(change.kind, "edit");
  assert.equal(change.changes.whole, false);
  assert.deepEqual(change.changes.docFields, ["productionTags"]);
  assert.deepEqual(change.changes.cells.map((c) => c.rowId + "." + c.field), ["r1.audioText", "r1.updatedAt", "r1.updatedBy"]);
  await settle();
  assert.equal(undoSizes().undo, sizes.undo + 1);
  undo();
  assert.equal(row("r1").audioText, "Grab the [Mug]");
  assert.deepEqual(tagNames(), []);
});

test("a typed [tag] refused by the session writes no registry record", async () => {
  await open();
  await settle();
  await asReviewer(async () => {
    await settle();
    const before = snapshot();
    const w = watch();
    try {
      typeTagClose();
    } finally {
      w.stop();
    }
    assert.deepEqual(tagNames(), []);
    assertUntouched(before, w.seen);
  });
});

test("a typed [tag] whose command fails leaves no registry record behind", async () => {
  await open();
  await settle();
  const before = snapshot();
  const w = watch();
  try {
    assert.throws(() => failingClock(typeTagClose), /no clock/);
  } finally {
    w.stop();
  }
  assert.deepEqual(tagNames(), []);
  assertUntouched(before, w.seen);
});

test("a Tab-closed plain tag writes its registry record in the same command", async () => {
  await open();
  await settle();
  const el = openPlainTag();
  const generation = liveSession().generation();
  const w = watch();
  try {
    assert.equal(closePlainTag(), true);
  } finally {
    w.stop();
  }
  assert.match(row("r2").visualText, /tag-anchor/);
  assert.deepEqual(tagNames(), ["prop:Kettle"]);
  assert.equal(liveSession().generation(), generation + 1);
  assert.equal(w.seen.length, 1);
  assert.deepEqual(w.seen[0].changes.docFields, ["productionTags"]);
  assert.ok(el);
});

test("a Tab-closed plain tag refused by the session writes no registry record", async () => {
  await open();
  await settle();
  await asReviewer(async () => {
    await settle();
    openPlainTag();
    const before = snapshot();
    const w = watch();
    try {
      assert.equal(closePlainTag(), true);
    } finally {
      w.stop();
    }
    assert.deepEqual(tagNames(), []);
    assertUntouched(before, w.seen);
  });
});

test("a Tab-closed plain tag whose command fails leaves no registry record behind", async () => {
  await open();
  await settle();
  openPlainTag();
  const before = snapshot();
  const w = watch();
  try {
    assert.throws(() => failingClock(closePlainTag), /no clock/);
  } finally {
    w.stop();
  }
  assert.deepEqual(tagNames(), []);
  assertUntouched(before, w.seen);
});

test("typing B-roll: writes the shot record in the same command as its key", async () => {
  await open(withBrollLine);
  await settle();
  const had = shotIds();
  const generation = liveSession().generation();
  const w = watch();
  let added;
  try {
    typeBrollMarker();
    added = shotIds().filter((id) => had.indexOf(id) === -1);
  } finally {
    w.stop();
  }
  const key = /data-broll-id="([^"]+)"/.exec(row("r3").visualText);
  assert.ok(key, "the marker became a b-roll key");
  assert.deepEqual(added, [key[1]]);
  assert.equal(currentDocument().brollShots.find((s) => s.id === key[1]).audioRef, "Steam");
  assert.equal(liveSession().generation(), generation + 1);
  assert.equal(w.seen.length, 1);
  assert.deepEqual(w.seen[0].changes.docFields, ["brollShots"]);
  await settle();
  undo();
  assert.equal(row("r3").visualText, "B-roll:");
  assert.equal(shotIds().indexOf(key[1]), -1, "undo takes the shot record back with its key");
});

test("typing B-roll: refused by the session writes no shot record", async () => {
  await open(withBrollLine);
  await settle();
  await asReviewer(async () => {
    await settle();
    const before = snapshot();
    const w = watch();
    try {
      typeBrollMarker();
      assertUntouched(before, w.seen);
    } finally {
      w.stop();
    }
  });
});

test("typing B-roll: whose command fails leaves no shot record behind", async () => {
  await open(withBrollLine);
  await settle();
  const before = snapshot();
  const w = watch();
  try {
    assert.throws(() => failingClock(typeBrollMarker), /no clock/);
    assertUntouched(before, w.seen);
  } finally {
    w.stop();
  }
});

const MEDIA_PASTE = '<img src="' + PIXEL + '"><br><span class="broll-key" data-broll-id="bspasted01" contenteditable="false">B-roll:</span> Drone';

test("control: the same media paste, allowed, attaches the picture and records the shot in its one command", async () => {
  await open();
  await settle();
  const el = cellOf("r1", "visualText");
  caretAtEnd(el);
  const generation = liveSession().generation();
  pasteIntoCell(el, MEDIA_PASTE, "B-roll: Drone");
  assert.equal(liveSession().generation(), generation + 1);
  assert.equal(shotIds().length, 1);
  assert.match(row("r1").visualText, new RegExp('data-broll-id="' + shotIds()[0] + '"'));
  assert.ok(row("r1").imageRef, "the picture is in the scene's gallery");
});

test("a refused media paste with a picture and a b-roll key leaves no picture, shot or tag record in the document", async () => {
  await open();
  await settle();
  const el = cellOf("r1", "visualText");
  caretAtEnd(el);
  const before = snapshot();
  const w = watch();
  const html = MEDIA_PASTE + ' <span class="tag-anchor" data-tag-cat="prop" data-tag-id="t_x">Lamp</span>';
  try {
    await asReviewer(() => pasteIntoCell(el, html, "B-roll: Drone Lamp"));
  } finally {
    w.stop();
  }
  assert.deepEqual(shotIds(), []);
  assert.deepEqual(tagNames(), []);
  assert.equal(row("r1").imageRef ?? null, null);
  assertUntouched(before, w.seen);
});

test("a refused import whose scan would track a b-roll line leaves no scene or shot record", async () => {
  await open();
  await settle();
  const before = snapshot();
  const w = watch();
  try {
    await asReviewer(() => {
      openImportModal();
      document.getElementById("import-textarea").value = "Visual: B-roll: Drone over the hill\nAudio: We start high.";
      document.querySelector('input[name="import-split"][value="twocolumn"]').checked = true;
      const box = document.querySelector('[data-import-scan="broll"]');
      if (box) box.checked = true;
      document.getElementById("import-confirm").click();
    });
  } finally {
    w.stop();
    closeImportModal();
  }
  assert.deepEqual(shotIds(), []);
  assertUntouched(before, w.seen);
});
