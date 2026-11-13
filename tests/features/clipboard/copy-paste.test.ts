import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import { startCellClipboard as mountCellClipboard, pasteIntoCell } from "../../../src/features/clipboard/cell-clipboard.ts";
import type { CellClipboardPorts, BeatClipPorts, BeatSelectPorts } from "../../../src/features/clipboard/ports.ts";
import { startBeatClip as mountBeatClip, parseBeatPayload } from "../../../src/features/clipboard/beat-clip.ts";
import { startBeatSelect as mountBeatSelect, selectBeats } from "../../../src/features/clipboard/beat-select.ts";
import type { ScreenState } from "../../../src/application/screen.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices, fakePictures } from "../fakes.ts";

function scriptDoc() {
  return migrateRows({ title: "Scenes", rows: [
    { id: "r1", visualText: "One", audioText: "" },
    { id: "r2", visualText: "Two", audioText: "" },
    { id: "r3", visualText: "Three", audioText: "" }
  ] }, fakeMigration().ports);
}

// why: the test DOM has no isContentEditable, and the field checks under test read it.
Object.defineProperty(window.HTMLElement.prototype, "isContentEditable", {
  configurable: true,
  get(this: HTMLElement) { return this.getAttribute("contenteditable") === "true"; }
});

const CLEAR_SCREEN: ScreenState = { loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false };

function rowHtml(id: string, tile = "is-cover"): string {
  return '<div class="row" data-id="' + id + '"><button class="status-btn" type="button">Todo</button>' +
    '<div class="cell-editable" contenteditable="true" tabindex="0" data-id="' + id + '" data-field="audioText">Words ' +
    '<a href="https://example.com/' + id + '">link</a></div>' +
    '<div class="visual-media"><button type="button" class="scene-gallery-tile ' + tile + '" data-action="gallery-open"><img alt=""></button>' +
    '<div class="image-thumb-actions"><button type="button" class="tile-replace" data-action="image-replace">Replace</button></div></div></div>';
}

function tileIn(id: string): Element {
  return document.querySelector('#rows .row[data-id="' + id + '"] .scene-gallery-tile img') as Element;
}

function paintedRows(): string {
  return ["r1", "r2", "r3"].map((id) => rowHtml(id)).join("");
}

function beatSelect(rowsHtml = "", screen: ScreenState = CLEAR_SCREEN) {
  document.body.innerHTML = '<div id="rows">' + rowsHtml + "</div>";
  const edits = fakeEdits();
  const notices = fakeNotices();
  const calls: string[] = [];
  const held = fakeDocument(scriptDoc());
  const ports: BeatSelectPorts = {
    document: held.document,
    lifetime: held.lifetime,
    edits: edits.edits,
    undo: {
      breakCoalescing: () => { calls.push("break"); },
      flush: () => { calls.push("flush"); },
      last: () => null,
      undo: () => { calls.push("undo"); }
    },
    pictures: fakePictures().pictures,
    notices: notices.notices,
    cells: { sync: () => {} },
    rowDrag: { dragging: () => null },
    scriptCell: () => true,
    rows: { closeMenus: () => {} },
    production: { scheduleRefresh: () => { calls.push("refresh"); } },
    stampRow: () => {},
    writerOpen: () => false,
    startNewScript: () => false,
    nonce: () => "n1",
    screen: () => screen
  };
  return { owner: mountBeatSelect(ports), edits, notices, calls, held };
}

function press(key: string): void {
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
}

function pressCtrlA(): boolean {
  const event = new window.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function pressOn(el: Element, mods: MouseEventInit = {}): boolean {
  const down = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...mods });
  el.dispatchEvent(down);
  el.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, ...mods }));
  return down.defaultPrevented;
}

function cellOf(id: string): HTMLElement {
  return document.querySelector('#rows .cell-editable[data-id="' + id + '"]') as HTMLElement;
}

function selectedIds(): string[] {
  return (window as unknown as { __sceneSelectTest: { ids: () => string[] } }).__sceneSelectTest.ids();
}

test("beat selection: a plain click places the cursor and selects no beat", () => {
  const { owner } = beatSelect(paintedRows());
  assert.equal(pressOn(cellOf("r1")), false);
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

test("beat selection: Ctrl+click adds and removes beats, and selected beats need not be adjacent", () => {
  const { owner } = beatSelect(paintedRows());
  assert.equal(pressOn(cellOf("r1"), { ctrlKey: true }), true);
  assert.equal(pressOn(cellOf("r3"), { ctrlKey: true }), true);
  assert.deepEqual(selectedIds(), ["r1", "r3"]);
  pressOn(cellOf("r1"), { ctrlKey: true });
  assert.deepEqual(selectedIds(), ["r3"]);
  pressOn(cellOf("r3"), { ctrlKey: true });
  assert.deepEqual(selectedIds(), []);
  assert.equal(document.body.classList.contains("has-scene-selection"), false);
  owner.dispose();
});

test("beat selection: Ctrl+click on a link leaves the click to the link", () => {
  const { owner } = beatSelect(paintedRows());
  assert.equal(pressOn(cellOf("r2").querySelector("a") as Element, { ctrlKey: true }), false);
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

test("beat selection: Ctrl+click on a control leaves the control alone", () => {
  const { owner } = beatSelect(paintedRows());
  const status = document.querySelector('#rows .row[data-id="r2"] .status-btn') as Element;
  assert.equal(pressOn(status, { ctrlKey: true }), false);
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

for (const tile of ["is-cover", "is-video", "is-more"]) {
  test("beat selection: Ctrl+click on a gallery picture (" + tile + ") adds its beat, removes it, and opens nothing", () => {
    const { owner } = beatSelect(["r1", "r2", "r3"].map((id) => rowHtml(id, tile)).join(""));
    let reached = 0;
    document.getElementById("rows")?.addEventListener("click", () => { reached++; });
    pressOn(cellOf("r1"), { ctrlKey: true });
    assert.equal(pressOn(tileIn("r3"), { ctrlKey: true }), true);
    assert.deepEqual(selectedIds(), ["r1", "r3"]);
    tileIn("r3").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    assert.equal(reached, 0);
    pressOn(tileIn("r3"), { ctrlKey: true });
    assert.deepEqual(selectedIds(), ["r1"]);
    owner.dispose();
  });
}

test("beat selection: Shift+click on a gallery picture selects up to its beat", () => {
  const { owner } = beatSelect(paintedRows());
  cellOf("r1").focus();
  assert.equal(pressOn(tileIn("r3"), { shiftKey: true }), true);
  assert.deepEqual(selectedIds(), ["r1", "r2", "r3"]);
  owner.dispose();
});

test("beat selection: a plain click on a gallery picture stays the gallery's", () => {
  const { owner } = beatSelect(paintedRows());
  let reached = 0;
  document.getElementById("rows")?.addEventListener("click", () => { reached++; });
  pressOn(cellOf("r1"), { ctrlKey: true });
  assert.equal(pressOn(tileIn("r3")), false);
  assert.deepEqual(selectedIds(), []);
  tileIn("r3").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(reached, 1);
  owner.dispose();
});

test("beat selection: Ctrl+click on the buttons over a gallery picture leaves them alone", () => {
  const { owner } = beatSelect(paintedRows());
  const replace = document.querySelector('#rows .row[data-id="r2"] .tile-replace') as Element;
  assert.equal(pressOn(replace, { ctrlKey: true }), false);
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

test("beat selection: the click a Ctrl+click ends in never reaches the row underneath", () => {
  const { owner } = beatSelect(paintedRows());
  let reached = 0;
  document.getElementById("rows")?.addEventListener("click", () => { reached++; });
  pressOn(cellOf("r2"), { ctrlKey: true });
  cellOf("r2").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  assert.equal(reached, 0);
  pressOn(cellOf("r1"));
  cellOf("r1").dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(reached, 1);
  owner.dispose();
});

test("beat selection: Shift+click selects from the beat holding the cursor, and takes the cursor out of the text", () => {
  const { owner } = beatSelect(paintedRows());
  cellOf("r1").focus();
  assert.equal(pressOn(cellOf("r3"), { shiftKey: true }), true);
  assert.deepEqual(selectedIds(), ["r1", "r2", "r3"]);
  assert.notEqual(document.activeElement, cellOf("r1"));
  owner.dispose();
});

test("beat selection: Shift+click selects from the last clicked beat when no cell holds the cursor", () => {
  const { owner } = beatSelect(paintedRows());
  pressOn(cellOf("r3"));
  cellOf("r3").blur();
  pressOn(cellOf("r2"), { shiftKey: true });
  assert.deepEqual(selectedIds(), ["r2", "r3"]);
  owner.dispose();
});

test("beat selection: Shift+click inside the beat holding the cursor stays text selection", () => {
  const { owner } = beatSelect(paintedRows());
  cellOf("r2").focus();
  assert.equal(pressOn(cellOf("r2"), { shiftKey: true }), false);
  assert.deepEqual(selectedIds(), []);
  assert.equal(document.activeElement, cellOf("r2"));
  owner.dispose();
});

test("beat selection: Shift+click with nothing to start from stays an ordinary click", () => {
  const { owner } = beatSelect(paintedRows());
  assert.equal(pressOn(cellOf("r2"), { shiftKey: true }), false);
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

test("beat selection: Shift+click after a Ctrl+click runs from the Ctrl+clicked beat and replaces the selection", () => {
  const { owner } = beatSelect(paintedRows());
  pressOn(cellOf("r3"), { ctrlKey: true });
  pressOn(cellOf("r1"), { ctrlKey: true });
  pressOn(cellOf("r2"), { shiftKey: true });
  assert.deepEqual(selectedIds(), ["r1", "r2"]);
  owner.dispose();
});

test("beat selection: a plain click and Esc each clear a Ctrl+click selection", () => {
  const { owner } = beatSelect(paintedRows());
  pressOn(cellOf("r1"), { ctrlKey: true });
  pressOn(cellOf("r3"), { ctrlKey: true });
  press("Escape");
  assert.deepEqual(selectedIds(), []);
  pressOn(cellOf("r1"), { ctrlKey: true });
  pressOn(cellOf("r2"));
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

test("beat selection: Delete with a gap removes only the selected beats", () => {
  const { owner, edits, notices } = beatSelect(paintedRows());
  pressOn(cellOf("r1"), { ctrlKey: true });
  pressOn(cellOf("r3"), { ctrlKey: true });
  press("Delete");
  assert.equal(edits.ran.length, 1);
  assert.deepEqual(notices.shown.map((n) => n.message), ["2 beats deleted."]);
  owner.dispose();
});

test("beat selection: the highlight draws a separate block for each run of selected beats", () => {
  const { owner } = beatSelect(paintedRows());
  pressOn(cellOf("r1"), { ctrlKey: true });
  pressOn(cellOf("r3"), { ctrlKey: true });
  const css = document.getElementById("scene-selection-style")?.textContent ?? "";
  assert.ok(css.includes('.row[data-id="r1"]'));
  assert.ok(css.includes('.row[data-id="r3"]'));
  assert.equal(css.includes('.row[data-id="r2"]'), false);
  assert.equal(css.split("inset 0 -2px 0").length - 1, 1);
  owner.dispose();
});

test("beat selection: Ctrl+A with focus outside a text field selects every beat, not the page's text", () => {
  const { owner } = beatSelect(paintedRows());
  assert.equal(pressCtrlA(), true);
  assert.deepEqual(selectedIds(), ["r1", "r2", "r3"]);
  owner.dispose();
});

test("beat selection: Ctrl+A inside a text field is the field's own", () => {
  const { owner } = beatSelect(paintedRows());
  cellOf("r2").focus();
  assert.equal(pressCtrlA(), false);
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

test("beat selection: Ctrl+A in an input is the input's own", () => {
  const { owner } = beatSelect(paintedRows());
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  assert.equal(pressCtrlA(), false);
  assert.deepEqual(selectedIds(), []);
  owner.dispose();
});

for (const blocker of ["loading", "dialog", "launcher", "tour", "prompter", "writer", "shotlist"] as const) {
  test("beat selection: Ctrl+A leaves the beats behind a " + blocker + " alone", () => {
    const { owner } = beatSelect(paintedRows(), { ...CLEAR_SCREEN, [blocker]: true });
    assert.equal(pressCtrlA(), false);
    assert.deepEqual(selectedIds(), []);
    owner.dispose();
  });
}

test("beat selection: Ctrl+A leaves out beats in a folded scene", () => {
  const { owner } = beatSelect(
    rowHtml("r1") + '<header class="section-header"><button class="section-fold" aria-expanded="false"></button></header>');
  pressCtrlA();
  assert.deepEqual(selectedIds(), ["r1"]);
  owner.dispose();
});

test("beat selection: a dragged range across a folded scene leaves out the folded beats", () => {
  const { owner } = beatSelect(
    rowHtml("r1") + '<header class="section-header"><button class="section-fold" aria-expanded="false"></button></header>' + rowHtml("r3"));
  selectBeats("r1", "r3");
  assert.deepEqual(selectedIds(), ["r1", "r3"]);
  owner.dispose();
});

test("scene selection: Delete removes the selected scenes through the edits port, between undo breaks, and says so", () => {
  const { owner, edits, notices, calls } = beatSelect();
  selectBeats("r1", "r2");
  press("Delete");
  assert.equal(edits.ran.length, 1);
  assert.deepEqual(calls, ["break", "flush", "break"]);
  assert.deepEqual(notices.shown.map((n) => n.message), ["2 beats deleted."]);
  owner.dispose();
});

test("scene clipboard: a fallback cut that finishes after the document has gone removes nothing and throws nothing", async () => {
  const { owner, edits, held } = beatSelect();
  const clip = mountBeatClip({
    ids: { id: (prefix) => prefix + "1" },
    pictures: fakePictures().pictures,
    text: { cellOf: () => [], fromHtml: () => [], inertBody: () => document.createElement("body") },
    migrate: (doc) => migrateRows(doc, fakeMigration().ports),
    tagsInRows: () => [],
    recordPastedBroll: () => {}
  });
  let finish: () => void = () => {};
  const clipboard = { writeText: () => { return new Promise<void>((resolve) => { finish = resolve; }); } };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  const failures: unknown[] = [];
  const onFailure = (reason: unknown): void => { failures.push(reason); };
  process.on("unhandledRejection", onFailure);
  try {
    selectBeats("r1", "r2");
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "x", ctrlKey: true, bubbles: true, cancelable: true }));
    held.replace(null);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onFailure);
    Reflect.deleteProperty(navigator, "clipboard");
    owner.dispose();
    clip.dispose();
  }
  assert.deepEqual(failures, []);
  assert.equal(edits.ran.length, 0);
});

async function fallbackCut(replaceWith: "none" | "same-ids" | "disk-merge" | "save-as") {
  const { owner, edits, held, calls } = beatSelect();
  const clip = mountBeatClip({
    ids: { id: (prefix) => prefix + "1" },
    pictures: fakePictures().pictures,
    text: { cellOf: () => [], fromHtml: () => [], inertBody: () => document.createElement("body") },
    migrate: (doc) => migrateRows(doc, fakeMigration().ports),
    tagsInRows: () => [],
    recordPastedBroll: () => {}
  });
  let finish: () => void = () => {};
  const clipboard = { writeText: () => { return new Promise<void>((resolve) => { finish = resolve; }); } };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  try {
    selectBeats("r1", "r2");
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "x", ctrlKey: true, bubbles: true, cancelable: true }));
    if (replaceWith === "same-ids") held.replace(scriptDoc());
    if (replaceWith === "disk-merge") {
      const epoch = held.lifetime.epoch();
      held.replace(scriptDoc());
      held.lifetime.epoch = () => epoch;
    }
    if (replaceWith === "save-as") (held.document.current() as { docId: string }).docId = "d" + "9".repeat(32);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    Reflect.deleteProperty(navigator, "clipboard");
    owner.dispose();
    clip.dispose();
  }
  return { edits, calls };
}

test("scene clipboard: a fallback cut that finishes after another script with the same ids opened removes nothing from it", async () => {
  const { edits } = await fallbackCut("same-ids");
  assert.equal(edits.ran.length, 0);
});

test("scene clipboard: a fallback cut that finishes after a disk merge replaced the document object removes nothing", async () => {
  const { edits } = await fallbackCut("disk-merge");
  assert.equal(edits.ran.length, 0);
});

test("scene clipboard: a fallback cut that finishes after Save As gave the same document a new id removes nothing", async () => {
  const { edits } = await fallbackCut("save-as");
  assert.equal(edits.ran.length, 0);
});

test("scene clipboard: a fallback cut in the same script still removes the beats in one undo step", async () => {
  const { edits, calls } = await fallbackCut("none");
  assert.equal(edits.ran.length, 1);
  assert.deepEqual(calls, ["break", "flush", "break"]);
});

test("scene selection: dispose removes its listeners and its highlight", () => {
  const { owner, edits } = beatSelect();
  selectBeats("r1");
  assert.ok(document.getElementById("scene-selection-style"));
  owner.dispose();
  assert.equal(document.getElementById("scene-selection-style"), null);
  assert.equal(document.body.classList.contains("has-scene-selection"), false);
  press("Delete");
  assert.equal(edits.ran.length, 0);
});

test("scene clipboard: a pasted payload's pictures go through the picture port and its scenes through the migrate port", () => {
  const pictures = fakePictures();
  const migrated: object[] = [];
  const ports: BeatClipPorts = {
    ids: { id: (prefix) => prefix + "1" },
    pictures: pictures.pictures,
    text: { cellOf: () => [], fromHtml: () => [], inertBody: (html) => { const body = document.createElement("body"); body.innerHTML = String(html); return body; } },
    migrate: (doc) => { migrated.push(doc); return migrateRows(doc, fakeMigration().ports); },
    tagsInRows: () => [],
    recordPastedBroll: () => {}
  };
  const owner = mountBeatClip(ports);
  const sha = "0".repeat(63) + "1";
  const clip = parseBeatPayload(JSON.stringify({
    format: "splitpage-scenes", version: 1,
    rows: [{ id: "r9", visualText: "Hello", audioText: "" }],
    blobs: { [sha]: "data:image/png;base64,AQ==" }
  }));
  assert.ok(clip);
  assert.deepEqual(clip.carried, [sha]);
  assert.deepEqual(pictures.persisted, [sha]);
  assert.equal(migrated.length, 1);
  assert.deepEqual(clip.rows.map((r: { id: string }) => r.id), ["r9"]);
  owner.dispose();
});

test("cell clipboard: a pasted video link alone goes to the scene's gallery through the edits port, between undo breaks", () => {
  document.body.innerHTML = '<div id="rows"><div class="cell-editable" data-id="r2" data-field="visualText"></div></div>';
  const edits = fakeEdits();
  const calls: string[] = [];
  const ports: CellClipboardPorts = {
    document: fakeDocument(scriptDoc()).document,
    edits: { run: (command) => { calls.push("run"); return edits.edits.run(command); }, text: { ...edits.edits.stamps, cells: () => [] } },
    undo: { breakCoalescing: () => { calls.push("break"); }, flush: () => { calls.push("flush"); } },
    pictures: fakePictures().pictures,
    text: { cellOf: () => [], fromHtml: () => [], inertBody: () => document.createElement("body"), cleanPastedCell: (cell) => Array.from(cell), storedHtmlFromDom: (html) => html },
    imageRefOf: () => null,
    ids: { id: (prefix) => prefix + "1" },
    nonce: () => "n1",
    selection: () => null,
    cells: { open: () => null, close: (cell) => cell },
    paintGuard: { whileShown: (edit) => edit() },
    brollSeed: () => ({ audioRef: "", location: "" })
  };
  const owner = mountCellClipboard(ports);
  const cell = document.querySelector(".cell-editable");
  assert.ok(cell);
  const res = pasteIntoCell(cell, "", "https://youtu.be/abc", null);
  assert.equal(res.done, true);
  assert.equal(res.rowIndex, 1);
  assert.deepEqual(calls, ["break", "run", "flush", "break"]);
  owner.dispose();
});
