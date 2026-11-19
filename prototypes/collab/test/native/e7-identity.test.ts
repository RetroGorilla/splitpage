import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { UndoLayer } from "../../src/native-undo/layer.ts";
import type { NativeHeadingReplica } from "../../src/native/headings.ts";
import { moveRow, moveScene } from "../../src/native-moves/moves.ts";
import { loadReplica, seedReplica } from "./e5-run.ts";
import { marked } from "./kit.ts";

function copies(count: number): NativeHeadingReplica[] {
  const seed = seedReplica("flag"), bytes = seed.encode();
  seed.destroy();
  return Array.from({ length: count }, (_, index) => loadReplica("flag", index + 1, bytes));
}

function send(from: NativeHeadingReplica, to: NativeHeadingReplica): void {
  Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
  to.changes();
}

function settle(all: readonly NativeHeadingReplica[]): void {
  for (const from of all) for (const to of all) if (from !== to) send(from, to);
}

function outline(replica: NativeHeadingReplica): string[] {
  return replica.outline().map(entry => entry.kind === "heading" ? `#${entry.id}` :
    `${entry.row.members.join("+")}: ${marked(entry.row.audio)}${entry.row.visual.length ? ` / ${marked(entry.row.visual)}` : ""}`);
}

function agreed(all: readonly NativeHeadingReplica[]): string[] {
  const late = loadReplica("flag", 800, (all[0] as NativeHeadingReplica).encode());
  try {
    const first = outline(late);
    for (const replica of all) assert.deepEqual(outline(replica), first);
    return first;
  } finally { late.destroy(); }
}

function layered(replica: NativeHeadingReplica): UndoLayer {
  const layer = new UndoLayer(replica);
  layer.manager.addToScope(replica.headings);
  return layer;
}

const START = ["#H0", "B0: O / P", "B1: bc / K", "#H1", "B2: ef / L", "B3: gh / M", "B4: ij / N"];
const B1_MOVED = ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B3: gh / M", "B1: bc / K", "B4: ij / N"];

test("E7 identity: formatting, a tag and a comment added during a move stay on the moved text", () => {
  for (const first of [0, 1]) {
    const all = copies(2), [mover, writer] = all as [NativeHeadingReplica, NativeHeadingReplica];
    try {
      moveRow(mover, "B1", "B3", true);
      writer.format("B1", "audioText", 0, 1, { b: true });
      writer.format("B1", "audioText", 1, 2, { "t:P": true });
      writer.format("B1", "audioText", 0, 2, { "c:C1": true });
      writer.format("B1", "visualText", 0, 1, { i: true });
      writer.changes();
      if (first) { send(writer, mover); send(mover, writer); } else { send(mover, writer); send(writer, mover); }
      assert.deepEqual(agreed(all), ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B3: gh / M", "B1: [b|b,c:C1][c|c:C1,t:P] / [K|i]", "B4: ij / N"]);
    } finally { all.forEach(replica => { replica.destroy(); }); }
  }
});

test("E7 undo: a move undoes and redoes as one step", () => {
  const [replica] = copies(1) as [NativeHeadingReplica], layer = layered(replica);
  try {
    layer.command(() => { moveRow(replica, "B1", "B3", true); });
    assert.deepEqual(outline(replica), B1_MOVED);
    layer.undo();
    replica.changes();
    assert.deepEqual(outline(replica), START);
    layer.redo();
    replica.changes();
    assert.deepEqual(outline(replica), B1_MOVED);
  } finally { replica.destroy(); }
});

test("E7 undo: undoing a move keeps another person's typing and split in the beat", () => {
  const all = copies(2), [mover, writer] = all as [NativeHeadingReplica, NativeHeadingReplica], layer = layered(mover);
  try {
    layer.command(() => { moveRow(mover, "B1", "B3", true); });
    settle(all);
    writer.splice("B1", "audioText", 1, 1, [{ text: "X", marks: {} }]);
    writer.split("B1", 1, "S9");
    writer.changes();
    settle(all);
    assert.deepEqual(agreed(all), ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B3: gh / M", "B1: b / K", "S9: Xc", "B4: ij / N"]);
    layer.undo();
    mover.changes();
    settle(all);
    assert.deepEqual(agreed(all), ["#H0", "B0: O / P", "B1: b / K", "S9: Xc", "#H1", "B2: ef / L", "B3: gh / M", "B4: ij / N"]);
  } finally { all.forEach(replica => { replica.destroy(); }); }
});

test("E7 undo: undoing a move that someone else has since moved again passes over it", () => {
  const all = copies(2), [mover, other] = all as [NativeHeadingReplica, NativeHeadingReplica], layer = layered(mover);
  try {
    layer.command(() => { moveRow(mover, "B1", "B3", true); });
    settle(all);
    moveRow(other, "B1", "B4", true);
    settle(all);
    const later = ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B3: gh / M", "B4: ij / N", "B1: bc / K"];
    assert.deepEqual(agreed(all), later);
    layer.undo();
    mover.changes();
    settle(all);
    assert.deepEqual(agreed(all), later);
  } finally { all.forEach(replica => { replica.destroy(); }); }
});

test("E7 undo: undoing a move restores the beats that hung on the moved beat", () => {
  const [replica] = copies(1) as [NativeHeadingReplica], layer = layered(replica);
  try {
    layer.command(() => { moveRow(replica, "B1", "B3", true); });
    layer.command(() => { moveRow(replica, "B3", "B4", true); });
    assert.deepEqual(outline(replica), ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B1: bc / K", "B4: ij / N", "B3: gh / M"]);
    layer.undo();
    replica.changes();
    assert.deepEqual(outline(replica), B1_MOVED);
    layer.undo();
    replica.changes();
    assert.deepEqual(outline(replica), START);
    layer.redo();
    layer.redo();
    replica.changes();
    assert.deepEqual(outline(replica), ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B1: bc / K", "B4: ij / N", "B3: gh / M"]);
  } finally { replica.destroy(); }
});

test("E7 undo: a scene move undoes and redoes, also after the heading is renamed by someone else", () => {
  const all = copies(2), [mover, other] = all as [NativeHeadingReplica, NativeHeadingReplica], layer = layered(mover);
  try {
    layer.command(() => { moveScene(mover, "H1", "H0", false); });
    settle(all);
    other.typeHeading("H1", 1, "X");
    other.changes();
    settle(all);
    const moved = ["#H1", "B2: ef / L", "B3: gh / M", "B4: ij / N", "#H0", "B0: O / P", "B1: bc / K"];
    assert.deepEqual(agreed(all), moved);
    layer.undo();
    mover.changes();
    settle(all);
    assert.deepEqual(agreed(all), START);
    layer.redo();
    mover.changes();
    settle(all);
    assert.deepEqual(agreed(all), moved);
  } finally { all.forEach(replica => { replica.destroy(); }); }
});

test("E7 undo: undoing the split that ended a moved beat's run leaves the moved row empty and both letters at the source", () => {
  const all = copies(2), [splitter, other] = all as [NativeHeadingReplica, NativeHeadingReplica], layer = layered(splitter);
  try {
    layer.command(() => { splitter.split("B1", 1, "S9"); });
    settle(all);
    moveRow(other, "B1", "B3", true);
    other.split("B1", 0, "S10");
    other.join("S10", "B1", " ");
    other.changes();
    settle(all);
    assert.deepEqual(agreed(all), ["#H0", "B0: O / P", "S9: c", "#H1", "B2: ef / L", "B3: gh / M", "B1+S10: b / K", "B4: ij / N"]);
    layer.undo();
    splitter.changes();
    settle(all);
    assert.deepEqual(agreed(all), ["#H0", "B0+S10: O bc / P", "#H1", "B2: ef / L", "B3: gh / M", "B1:  / K", "B4: ij / N"]);
  } finally { all.forEach(replica => { replica.destroy(); }); }
});

test("E7 undo: undoing a split of the beat a moved beat sits after puts it back after the whole beat", () => {
  const [replica] = copies(1) as [NativeHeadingReplica], layer = layered(replica);
  try {
    layer.command(() => { moveRow(replica, "B1", "B3", true); });
    layer.command(() => { replica.split("B3", 1, "S9"); });
    assert.deepEqual(outline(replica), ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B3: g / M", "S9: h", "B1: bc / K", "B4: ij / N"]);
    layer.undo();
    replica.changes();
    assert.deepEqual(outline(replica), B1_MOVED);
    layer.redo();
    replica.changes();
    assert.deepEqual(outline(replica), ["#H0", "B0: O / P", "#H1", "B2: ef / L", "B3: g / M", "S9: h", "B1: bc / K", "B4: ij / N"]);
  } finally { replica.destroy(); }
});
