import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { typeInto, writerFor, writerPage } from "./painted-base-support.ts";
import { createSurface } from "../../../src/features/writer/flow-surface.ts";
import { domKeys } from "../../../src/features/common/cell-dom.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowRow } from "../../../src/core/flow/flow.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { createEditorSelection } from "../../../src/application/editing/selection.ts";
import type { PaintedText, PaintedTextSource } from "../../../src/application/editing/ports.ts";
import { fakePaintedText } from "../fakes.ts";
import type { FakePaintedBeat } from "../fakes.ts";

const ATOM = "￼";
const WHO = '<span class="who-anchor" data-who="Sam">@Sam</span>';
const ROWS: readonly FlowRow[] = [
  { id: "e", audioText: "a\u{1f600}b" },
  { id: "w", audioText: "x " + WHO + " y" },
  { id: "m", audioText: "pl<strong>bo</strong>ld" },
  { id: "n", audioText: "" }
];
const SHARED: Readonly<Record<string, FakePaintedBeat>> = {
  e: { revision: 7, units: [["e0", "a"], ["e1", "\ud83d"], ["e2", "\ude00"], ["e3", "b"]] },
  w: { revision: 7, units: [["w0", "x"], ["w1", " "], ["w2", ATOM], ["w3", " "], ["w4", "y"]] },
  m: { revision: 7, units: [["m0", "p"], ["m1", "l"], ["m2", "b"], ["m3", "o"], ["m4", "l"], ["m5", "d"]] },
  n: { revision: 7, units: [] }
};

function at(revision: number, beats: Readonly<Record<string, FakePaintedBeat>>): Record<string, FakePaintedBeat> {
  return Object.fromEntries(Object.entries(beats).map(([id, beat]) => [id, { ...beat, revision }]));
}

function surfaceFor(rows: readonly FlowRow[], source?: PaintedTextSource) {
  const root = writerPage();
  let doc: FlowDoc = { rows, comments: [] };
  let ids = 0;
  const synced: string[] = [];
  const hooks: { synced: (rowId: string) => void } = { synced: () => {} };
  const surface = createSurface({
    ...(source ? { paintedText: source } : {}),
    lifetime: { epoch: () => 1 },
    heldSelection: createEditorSelection({ epoch: () => 1, order: () => [], keys: () => null }),
    root, doc: () => doc,
    flow: { cells: html => fromHtml(html ?? ""), newId: () => "new" + ++ids, hasVisual: () => false },
    decode: fromHtml, storedHtml: html => html,
    moveBeat: () => {}, editingBlocked: () => false,
    syncBeat: rowId => { synced.push(rowId); hooks.synced(rowId); },
    commit: (_name, operation) => {
      const outcome = operation(doc);
      if (outcome && "rows" in outcome) doc = { ...doc, rows: outcome.rows, sections: outcome.sections };
      return outcome;
    },
    undo: () => {}, notice: () => {}, changed: () => {}, selectionMoved: () => {},
    settings: () => ({ enter: "double", tick: "delete", gapTyping: "here", markdown: true }),
    openFind: () => {}, plainVisual: () => ""
  });
  const beat = (id: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>('.wr-beat[data-id="' + id + '"]');
    assert.ok(el, "beat " + id);
    return el;
  };
  return { surface, root, synced, hooks, beat, show: (next: readonly FlowRow[]): void => { doc = { ...doc, rows: next }; } };
}

function units(base: PaintedText | null): [identity: string | null, text: string][] {
  assert.ok(base);
  const out: [string | null, string][] = [];
  for (let index = 0; index < base.text.length; index++) out.push([base.identity(index), base.text.charAt(index)]);
  assert.equal(base.identity(base.text.length), null);
  return out;
}

test("a paint records, for every painted beat, one identity per painted unit and the revision read then", () => {
  const fake = fakePaintedText(7, SHARED), h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    assert.deepEqual(fake.reads, [["e", "audioText"], ["w", "audioText"], ["m", "audioText"], ["n", "audioText"]]);
    assert.deepEqual(domKeys(h.beat("e")), ["a", "\ud83d", "\ude00", "b"]);
    assert.deepEqual(domKeys(h.beat("w")), ["x", " ", ATOM + "who:Sam", " ", "y"]);
    assert.deepEqual(domKeys(h.beat("m")), ["p", "l", "b", "o", "l", "d"]);
    assert.deepEqual(domKeys(h.beat("n")), []);
    assert.deepEqual(units(h.surface.paintedBase("e")), [["e0", "a"], ["e1", "\ud83d"], ["e2", "\ude00"], ["e3", "b"]]);
    assert.deepEqual(units(h.surface.paintedBase("w")), [["w0", "x"], ["w1", " "], ["w2", ATOM], ["w3", " "], ["w4", "y"]]);
    assert.deepEqual(units(h.surface.paintedBase("m")), [["m0", "p"], ["m1", "l"], ["m2", "b"], ["m3", "o"], ["m4", "l"], ["m5", "d"]]);
    assert.deepEqual(units(h.surface.paintedBase("n")), []);
    assert.deepEqual(["e", "w", "m", "n"].map(id => h.surface.paintedBase(id)?.revision), [7, 7, 7, 7]);
    assert.equal(h.surface.paintedBase("absent"), null);
  } finally { h.surface.dispose(); }
});

test("paint-time base: the record is the one read at paint, not at a later lookup", () => {
  const fake = fakePaintedText(7, SHARED), h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    fake.show({ ...at(8, SHARED), m: { revision: 8, units: [["x0", "p"], ["x1", "l"], ["x2", "b"], ["x3", "o"], ["x4", "l"], ["x5", "d"]] } });
    fake.project(8);
    assert.equal(h.surface.paintedBase("m")?.revision, 7);
    assert.deepEqual(units(h.surface.paintedBase("m")), [["m0", "p"], ["m1", "l"], ["m2", "b"], ["m3", "o"], ["m4", "l"], ["m5", "d"]]);
    assert.equal(fake.reads.length, 4);
  } finally { h.surface.dispose(); }
});

test("paint-time base: a sync the paint itself runs comes before the read, so the record is of what the pass showed", () => {
  const fake = fakePaintedText(7, SHARED), h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    h.hooks.synced = rowId => {
      assert.equal(rowId, "e");
      h.show([{ id: "e", audioText: "a\u{1f600}bZ" }, ...ROWS.slice(1)]);
      fake.show(at(8, { ...SHARED, e: { revision: 8, units: [["e0", "a"], ["e1", "\ud83d"], ["e2", "\ude00"], ["e3", "b"], ["e4", "Z"]] } }));
      fake.project(8);
    };
    h.beat("e").after(document.createTextNode("Z"));
    h.surface.paint();
    assert.deepEqual(h.synced, ["e"]);
    assert.deepEqual(domKeys(h.beat("e")), ["a", "\ud83d", "\ude00", "b", "Z"]);
    assert.deepEqual(units(h.surface.paintedBase("e")), [["e0", "a"], ["e1", "\ud83d"], ["e2", "\ude00"], ["e3", "b"], ["e4", "Z"]]);
    assert.deepEqual(["e", "w", "m", "n"].map(id => h.surface.paintedBase(id)?.revision), [8, 8, 8, 8]);
  } finally { h.surface.dispose(); }
});

test("a beat whose painted text differs from the shared text gets no base", () => {
  const fake = fakePaintedText(7, { ...SHARED, m: { revision: 7, units: [["m0", "p"], ["m1", "l"], ["m2", "b"], ["m3", "o"], ["m4", "l"]] },
    w: { revision: 7, units: [["w0", "x"], ["w1", " "], ["w2", "@"], ["w3", " "], ["w4", "y"]] } });
  const h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    assert.deepEqual(["e", "w", "m", "n"].map(id => h.surface.paintedBase(id) !== null), [true, false, false, true]);
  } finally { h.surface.dispose(); }
});

test("equal text at another revision than the painted document's is no base until the document catches up", () => {
  const fake = fakePaintedText(1, { r: { revision: 1, units: [["a1", "a"], ["a2", "a"]] } });
  const h = surfaceFor([{ id: "r", audioText: "aa" }], fake.paintedText);
  try {
    h.surface.paint();
    assert.deepEqual(units(h.surface.paintedBase("r")), [["a1", "a"], ["a2", "a"]]);
    assert.equal(h.surface.paintedBase("r")?.revision, 1);
    fake.show({ r: { revision: 3, units: [["a2", "a"], ["a3", "a"]] } });
    h.surface.paint();
    assert.deepEqual(fake.reads, [["r", "audioText"], ["r", "audioText"]]);
    assert.equal(h.surface.paintedBase("r"), null);
    fake.project(3);
    h.surface.paint();
    assert.deepEqual(units(h.surface.paintedBase("r")), [["a2", "a"], ["a3", "a"]]);
    assert.equal(h.surface.paintedBase("r")?.revision, 3);
  } finally { h.surface.dispose(); }
});

test("a repaint replaces the record of every beat it shows, changed or not", () => {
  const fake = fakePaintedText(7, SHARED), h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    h.show([ROWS[0] as FlowRow, { id: "m", audioText: "pl<strong>bo</strong>ldX" }]);
    fake.show({
      e: { revision: 9, units: [["e0", "a"], ["f1", "\ud83d"], ["f2", "\ude00"], ["e3", "b"]] },
      m: { revision: 9, units: [["m0", "p"], ["m1", "l"], ["m2", "b"], ["m3", "o"], ["m4", "l"], ["m5", "d"], ["m6", "X"]] }
    });
    fake.project(9);
    h.surface.repaint();
    assert.deepEqual(fake.reads.slice(4), [["e", "audioText"], ["m", "audioText"]]);
    assert.deepEqual(units(h.surface.paintedBase("e")), [["e0", "a"], ["f1", "\ud83d"], ["f2", "\ude00"], ["e3", "b"]]);
    assert.deepEqual(units(h.surface.paintedBase("m")), [["m0", "p"], ["m1", "l"], ["m2", "b"], ["m3", "o"], ["m4", "l"], ["m5", "d"], ["m6", "X"]]);
    assert.deepEqual(["e", "m"].map(id => h.surface.paintedBase(id)?.revision), [9, 9]);
  } finally { h.surface.dispose(); }
});

test("surface bound: a beat that left the surface keeps no record, over many repaints", () => {
  const fake = fakePaintedText(7, SHARED), h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    h.show([ROWS[0] as FlowRow, ROWS[3] as FlowRow]);
    h.surface.paint();
    assert.deepEqual(["e", "w", "m", "n"].map(id => h.surface.paintedBase(id) !== null), [true, false, false, true]);
    const ever = ["e", "w", "m", "n"];
    for (let round = 0; round < 40; round++) {
      const ids = [0, 1, 2].map(index => "r" + round + "-" + index);
      h.show(ids.map(id => ({ id, audioText: "ab" })));
      fake.show(Object.fromEntries(ids.map(id => [id, { revision: 10 + round, units: [[id + ":0", "a"], [id + ":1", "b"]] }])));
      fake.project(10 + round);
      h.surface.paint();
      ever.push(...ids);
      assert.equal(ever.filter(id => h.surface.paintedBase(id) !== null).length, 3);
    }
    assert.equal(ever.length, 124);
    assert.deepEqual(ever.filter(id => h.surface.paintedBase(id) !== null), ["r39-0", "r39-1", "r39-2"]);
    assert.equal(h.root.querySelectorAll(".wr-beat").length, 3);
    h.surface.dispose();
    assert.deepEqual(ever.filter(id => h.surface.paintedBase(id) !== null), []);
  } finally { h.surface.dispose(); }
});

test("a repaint owed during composition leaves the painted record until the composition ends", () => {
  const fake = fakePaintedText(7, SHARED), h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    h.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
    fake.show(at(8, SHARED));
    fake.project(8);
    h.surface.repaint();
    assert.equal(fake.reads.length, 4);
    assert.equal(h.surface.paintedBase("n")?.revision, 7);
    h.root.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
    assert.equal(fake.reads.length, 8);
    assert.deepEqual(["e", "w", "m", "n"].map(id => h.surface.paintedBase(id)?.revision), [8, 8, 8, 8]);
  } finally { h.surface.dispose(); }
});

test("native typing reads nothing from the source and keeps the painted record", () => {
  const fake = fakePaintedText(7, SHARED), h = surfaceFor(ROWS, fake.paintedText);
  try {
    h.surface.paint();
    const painted = h.surface.paintedBase("e");
    h.surface.place({ anchor: beatPos("e", 3), head: beatPos("e", 3) });
    typeInto(h.root, h.beat("e"), "Z");
    assert.deepEqual(h.synced, ["e"]);
    assert.equal(h.beat("e").textContent, "a\u{1f600}bZ");
    assert.equal(fake.reads.length, 4);
    assert.equal(h.surface.paintedBase("e"), painted);
    assert.deepEqual(units(painted), [["e0", "a"], ["e1", "\ud83d"], ["e2", "\ude00"], ["e3", "b"]]);
  } finally { h.surface.dispose(); }
});

test("standalone: painting, typing and a beat split never create or call the painted-beat record", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { pathToFileURL } from "node:url";
    let created = 0, recorded = 0;
    mock.module(pathToFileURL("src/application/editing/painted-beats.ts").href, { namedExports: { createPaintedBeats: () => {
      created++;
      return { record: () => { recorded++; }, base: () => null, clear: () => {} };
    } } });
    const { writerFor } = await import("./tests/features/writer/painted-base-support.ts");
    const standalone = writerFor();
    assert.deepEqual(standalone.session(), ["a=Al", "new=phas", "b=Bravo"]);
    standalone.writer.dispose();
    assert.deepEqual([created, recorded], [0, 0]);
    const shared = writerFor({ documentRevision: () => 0, read: () => null });
    assert.deepEqual(shared.session(), ["a=Al", "new=phas", "b=Bravo"]);
    shared.writer.dispose();
    assert.deepEqual([created, recorded], [1, 3]);
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const wiring = readFileSync(new URL("../../../src/bootstrap/wiring/writer.ts", import.meta.url), "utf8");
  assert.equal(wiring.includes("paintedText"), false);
});

test("the Writer hands its painted-text source to the surface: one read per painted beat per paint, none per keystroke", () => {
  const fake = fakePaintedText(0, {}), h = writerFor(fake.paintedText);
  try {
    assert.deepEqual(h.session(), ["a=Al", "new=phas", "b=Bravo"]);
    assert.deepEqual(fake.reads.map(([rowId, field]) => rowId + "." + field), [
      "a.audioText", "b.audioText",
      "a.audioText", "new.audioText", "b.audioText",
      "a.audioText", "new.audioText", "b.audioText"
    ]);
  } finally { h.writer.dispose(); }
});
