import assert from "node:assert/strict";
import { after, test } from "node:test";
import { dom } from "../../../../src/test/_dom.mjs";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { removeNativeHeading } from "../../../../src/adapters/collab/native/heading-commands.ts";
import { convertedScript } from "./helpers.ts";
import { blockOrder, join, remove, split, stateOf, storedOf, structureScript } from "./structure-harness.ts";

after(() => { dom.window.close(); });

const BASE = structureScript({ A: "ab", B: "cd", C: "ef", D: "gh", E: "ij" }, { A: "1", B: "2", C: "3" }, [{ id: "P", name: "Scene", before: "D" }]);

test("mixed blocks move in one origin-tagged transaction that touches only the requested ranks", () => {
  const script = convertedScript(BASE), before = storedOf(script), writes: string[] = [];
  const { roots } = script;
  let updates = 0;
  script.doc.on("update", (_, origin) => { assert.equal(origin, script.origin); updates++; });
  roots.beats.observeDeep(events => events.forEach(event => writes.push(`${event.path.join("/")}/${[...event.keys.keys()].join(",")}`)));
  roots.headings.observeDeep(events => events.forEach(event => writes.push(`${event.path.join("/")}/${[...event.keys.keys()].join(",")}`)));
  assert.deepEqual(moveNativeBlocks(script, ["B", "P", "D"], "A"), { kind: "written" });
  assert.deepEqual(blockOrder(script), ["B", "#P", "D", "A", "C", "E"]);
  assert.deepEqual(writes.sort(), ["B/rank", "D/rank", "P/rank"]);
  assert.equal(updates, 1);
  assert.equal(storedOf(script), before);
  assert.deepEqual(script.reader.rows().map(row => [row.id, row.audioText, row.visualText]), [
    ["B", "cd", "2"], ["D", "gh", ""], ["A", "ab", "1"], ["C", "ef", "3"], ["E", "ij", ""]
  ]);
  script.doc.destroy();
});

test("join head moves alone unless members are named, and a later move can reactivate the kept join", () => {
  const script = convertedScript(BASE), rank = script.roots.beats.get("B")?.get("rank");
  join(script, "B", "A");
  assert.deepEqual(moveNativeBlocks(script, ["A"], null), { kind: "written" });
  assert.equal(script.roots.beats.get("B")?.get("rank"), rank);
  assert.deepEqual(script.reader.row("B")?.members, ["B"]);
  assert.deepEqual(script.roots.beats.get("B")?.get("joined"), { into: "A", glue: " " });
  assert.deepEqual(moveNativeBlocks(script, ["A"], "B"), { kind: "written" });
  assert.deepEqual(script.reader.row("A")?.members, ["A", "B"]);
  assert.deepEqual(moveNativeBlocks(script, ["A", "B"], null), { kind: "written" });
  assert.deepEqual(blockOrder(script), ["C", "#P", "D", "E", "A", "B"]);
  assert.deepEqual(script.reader.row("A")?.members, ["A", "B"]);
  script.doc.destroy();
});

test("opening a tied gap re-ranks its entire right side and leaves the left and next ranked block alone", () => {
  const script = convertedScript(BASE), { beats } = script.roots;
  const x = split(script, "B", 0), y = split(script, x, 1), left = beats.get("B")?.get("rank"), limit = beats.get("C")?.get("rank");
  assert.deepEqual(moveNativeBlocks(script, ["D", "E"], x), { kind: "written" });
  assert.deepEqual(blockOrder(script), ["A", "B", "D", "E", x, y, "C", "#P"]);
  assert.equal(beats.get("B")?.get("rank"), left);
  assert.equal(beats.get("C")?.get("rank"), limit);
  const ranks = ["B", "D", "E", x, y, "C"].map(id => beats.get(id)?.get("rank"));
  assert.deepEqual(ranks, [...new Set(ranks)].sort());
  script.doc.destroy();
});

test("rankless neighbours retain their shown rank, including the open start of a rankless run", () => {
  const script = convertedScript(BASE), { beats } = script.roots;
  const rank = beats.get("B")?.get("rank");
  beats.get("C")?.delete("rank");
  assert.deepEqual(moveNativeBlocks(script, ["D"], "P"), { kind: "written" });
  assert.equal(beats.get("C")?.get("rank"), rank);
  assert.deepEqual(blockOrder(script), ["A", "B", "C", "D", "#P", "E"]);
  beats.get("A")?.delete("rank"); beats.get("B")?.delete("rank");
  assert.deepEqual(moveNativeBlocks(script, ["E"], "B"), { kind: "written" });
  assert.deepEqual(blockOrder(script), ["A", "E", "B", "C", "D", "#P"]);
  assert.equal(typeof beats.get("A")?.get("rank"), "string");
  assert.equal(typeof beats.get("B")?.get("rank"), "string");
  script.doc.destroy();
});

test("a rankless drop target keeps its old shown rank when its narration predecessor is moved", () => {
  const script = convertedScript(BASE), { beats } = script.roots;
  const shownRank = beats.get("A")?.get("rank");
  beats.get("B")?.delete("rank");
  assert.deepEqual(moveNativeBlocks(script, ["A", "C"], "B"), { kind: "written" });
  assert.equal(beats.get("B")?.get("rank"), shownRank);
  assert.deepEqual(blockOrder(script), ["A", "C", "B", "#P", "D", "E"]);
  script.doc.destroy();
});

test("refusals and no-ops leave the full encoded update unchanged", () => {
  const script = convertedScript(BASE);
  remove(script, "D");
  assert.equal(removeNativeHeading(script, "P").kind, "written");
  script.roots.visuals.delete("C");
  script.roots.beats.delete("B");
  const before = stateOf(script), sparse = Array<string>(2);
  sparse[1] = "A";
  for (const [ids, drop] of [
    [["A", "B"], null], [["A"], "B"], [["E", "C"], null], [["A"], "C"], [["D"], null], [["A"], "D"],
    [["P"], null], [["A"], "P"], [["U"], null], [["A"], "U"], [["A", "A"], null], [["E", "A"], null],
    [["A"], "A"], [sparse, null], [[["A"]], null], ["A", null], [{ length: 1, 0: "A" }, null], [["A"], {}]
  ] as const) {
    assert.deepEqual(moveNativeBlocks(script, ids as unknown as readonly string[], drop as string | null), { kind: "refused", reason: "missing" });
    assert.deepEqual(stateOf(script), before);
  }
  assert.deepEqual(moveNativeBlocks(script, ["A"], "E"), { kind: "unchanged" });
  assert.deepEqual(moveNativeBlocks(script, [], null), { kind: "unchanged" });
  assert.deepEqual(stateOf(script), before);
  script.doc.destroy();
});

test("a malformed stored rank on a selected block, neighbour or tied gap's upper bound refuses unwritten", () => {
  const script = convertedScript(BASE);
  for (const [id, value, ids, drop] of [
    ["B", 17, ["B"], null], ["A", "", ["D"], "B"], ["B", "negative-rank", ["D"], "B"], ["E", "zz!", ["A"], null]
  ] as const) {
    const record = script.roots.beats.get(id);
    assert.ok(record);
    const rank = record.get("rank");
    record.set("rank", value);
    const before = stateOf(script);
    assert.deepEqual(moveNativeBlocks(script, ids, drop), { kind: "refused", reason: "stored" });
    assert.deepEqual(stateOf(script), before);
    record.set("rank", rank);
  }
  const x = split(script, "B", 1);
  script.roots.beats.get("C")?.set("rank", script.roots.beats.get(x)?.get("rank") + "!");
  const before = stateOf(script);
  assert.deepEqual(moveNativeBlocks(script, ["D"], x), { kind: "refused", reason: "stored" });
  assert.deepEqual(stateOf(script), before);
  script.doc.destroy();
});

test("the list is copied by index before availability and no caller getter runs inside the move transaction", () => {
  const script = convertedScript(BASE), reads: string[] = [];
  const list = new Proxy(["B", "C"], { get(target, property) {
    assert.equal(script.busy(), false);
    assert.notEqual(property, Symbol.iterator);
    reads.push(String(property));
    return Reflect.get(target, property) as unknown;
  } });
  assert.deepEqual(moveNativeBlocks(script, list, null), { kind: "written" });
  assert.deepEqual(reads, ["length", "0", "1"]);
  const before = stateOf(script);
  const throwing = new Proxy(["A"], { get() { throw new Error("caller"); } });
  assert.deepEqual(moveNativeBlocks(script, throwing, null), { kind: "refused", reason: "missing" });
  script.doc.transact(() => {
    assert.deepEqual(moveNativeBlocks(script, ["A"], null), { kind: "refused", reason: "busy" });
  });
  assert.deepEqual(stateOf(script), before);
  const closing = new Proxy(["A"], { get(target, property) {
    script.close();
    return Reflect.get(target, property) as unknown;
  } });
  assert.deepEqual(moveNativeBlocks(script, closing, null), { kind: "refused", reason: "closed" });
  assert.deepEqual(stateOf(script), before);
  script.doc.destroy();
});
