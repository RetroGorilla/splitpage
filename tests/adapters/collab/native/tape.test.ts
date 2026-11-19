import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import type { Run } from "../../../../src/core/text/runs.ts";
import { replaceNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeReadRow } from "../../../../src/adapters/collab/native/reader.ts";
import { ScriptNet, cells, convertedScript, joinedScript } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";
import { spliceUnits, typingTape, unitKeys, unitsOf } from "./tape.ts";

after(() => { dom.window.close(); });

type Reading = (script: NativeScript, beat: string) => NativeReadRow | null;
type Order = Delivery | "state";

const tape = typingTape(3);
const honest: Reading = (script, beat) => script.reader.row(beat);

function settle(net: ScriptNet, order: Order): void {
  if (order !== "state") { net.settle(order); return; }
  for (const to of net.scripts) for (const from of net.scripts) {
    if (from !== to) Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)), "remote");
  }
  for (const script of net.scripts) script.reader.refresh();
}

function model(): Map<string, Run[]> {
  const cellsByTarget = new Map<string, Run[]>();
  for (const row of tape.document.rows) for (const cell of ["narration", "visual"]) cellsByTarget.set(row.id + "/" + cell, []);
  return cellsByTarget;
}

function check(scripts: readonly NativeScript[], expected: ReadonlyMap<string, Run[]>, read: Reading): void {
  for (const script of scripts) for (const row of tape.document.rows) {
    const shown = read(script, row.id);
    assert.ok(shown, `copy ${script.doc.clientID} lost row ${row.id}`);
    assert.deepEqual(unitKeys(shown.narration), unitKeys(expected.get(row.id + "/narration") ?? []), `copy ${script.doc.clientID}, ${row.id} narration`);
    assert.deepEqual(unitKeys(shown.visual), unitKeys(expected.get(row.id + "/visual") ?? []), `copy ${script.doc.clientID}, ${row.id} visual`);
  }
}

function runTape(order: Order, read: Reading = honest, mute = -1): { scripts: NativeScript[]; expected: Map<string, Run[]> } {
  const seed = convertedScript(tape.document, 1), scripts = [2, 3, 4].map(id => joinedScript(seed, id)), net = new ScriptNet(scripts), expected = model();
  let writer = scripts[0] as NativeScript, index = 0;
  for (const op of tape.ops) {
    if (op.op === "turn") { settle(net, order); writer = scripts[op.writer] as NativeScript; continue; }
    const units = expected.get(op.target.beat + "/" + op.target.cell);
    assert.ok(units);
    spliceUnits(units, op.from, op.to, op.insert);
    const at = index++;
    if (at !== mute) assert.equal(replaceNativeText(writer, op.target, op.from, op.to, op.insert).kind, "written", `op ${at} refused`);
    const row = read(writer, op.target.beat);
    assert.deepEqual(unitKeys((op.target.cell === "narration" ? row?.narration : row?.visual) ?? []), unitKeys(units), `op ${at}: ${op.target.beat} ${op.target.cell}`);
  }
  settle(net, order);
  const late = joinedScript(scripts[0] as NativeScript, 9);
  check([...scripts, late], expected, read);
  assert.deepEqual(net.agree().length, tape.document.rows.length);
  return { scripts: [...scripts, late], expected };
}

test("the tape's expectations come from its own commands and leave the source text where nothing was revised", () => {
  const expected = model();
  for (const op of tape.ops) if (op.op === "splice") spliceUnits(expected.get(op.target.beat + "/" + op.target.cell) ?? [], op.from, op.to, op.insert);
  for (const row of tape.source.rows) {
    if (!tape.revised.includes(row.id)) assert.deepEqual(unitKeys(expected.get(row.id + "/narration") ?? []), unitKeys(cells(String(row.audioText ?? ""))), row.id);
    assert.deepEqual(unitKeys(expected.get(row.id + "/visual") ?? []), unitKeys(cells(String(row.visualText ?? ""))), row.id);
  }
  assert.ok(tape.typed > 10000 && tape.atoms > 0 && tape.corrections > 100, JSON.stringify({ typed: tape.typed, atoms: tape.atoms, corrections: tape.corrections }));
});

for (const order of ["forward", "reverse", "twice", "state"] as const) {
  test(`the typing tape on three copies and a late joiner, delivered ${order}: every copy and a fresh reader read the commands' text`, () => {
    const { scripts } = runTape(order);
    for (const script of scripts) assert.deepEqual(script.reader.unplaced(), []);
  });
}

test("control: a muted keystroke is caught", () => {
  const middle = Math.floor(tape.ops.filter(op => op.op === "splice").length / 2);
  assert.throws(() => runTape("forward", honest, middle), new RegExp(`^AssertionError.*op ${middle}: `, "s"));
});

test("control: reading the neighbouring row's text is caught", () => {
  const ids = tape.document.rows.map(row => row.id);
  const wrong: Reading = (script, beat) => script.reader.row(ids[(ids.indexOf(beat) + 1) % ids.length] ?? beat);
  assert.throws(() => runTape("forward", wrong), /op 0: /);
});

test("the tape types every unit it counts", () => {
  const units = tape.source.rows.reduce((sum, row) => sum + unitsOf(cells(String(row.audioText ?? ""))).length + unitsOf(cells(String(row.visualText ?? ""))).length, 0);
  assert.ok(units > 0 && tape.ops.filter(op => op.op === "splice").length >= units);
});
