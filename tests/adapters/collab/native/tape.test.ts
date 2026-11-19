import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { tagStack } from "../../../../src/core/text/runs.ts";
import type { Marks, Run } from "../../../../src/core/text/runs.ts";
import { nativeMarkName } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeDeltaItem } from "../../../../src/adapters/collab/native/inline.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { nativeSegmentSpans } from "../../../../src/adapters/collab/native/reader.ts";
import type { NativeReadRow } from "../../../../src/adapters/collab/native/reader.ts";
import { ScriptNet, cells, convertedScript, edit, joinedScript } from "./helpers.ts";
import type { Delivery } from "./helpers.ts";
import { shownKeys, spliceUnits, typingTape, unitKeys, unitsOf } from "./tape.ts";

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

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) => inner && typeof inner === "object" && !Array.isArray(inner)
    ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : inner);
}

function requestedAttributes(marks: Marks, atom: boolean): string[] {
  const keys = ["b", "i", "u", "s", "hl", "dir", "cue"].filter(key => (marks as Record<string, unknown>)[key]);
  for (const id of marks.cmt ?? []) keys.push("c:" + id);
  if (marks.href) keys.push("l:" + marks.href);
  if (!atom) for (const id of tagStack(marks)) keys.push("t:" + id);
  return [...new Set(keys)].sort();
}

function requestedEmbed(unit: Run): unknown {
  if (unit.atom === "broll") return { k: unit.id, label: unit.text };
  if (unit.atom === "who") return { w: unit.name };
  if (unit.atom === "image") return { img: unit.ref };
  return unit.atom === "video" ? { video: unit.href, host: unit.host } : null;
}

function requestedUnits(runs: readonly Run[]): string[] {
  return unitsOf(runs).map(unit => sortedJson([unit.atom ? requestedEmbed(unit) : unit.text, requestedAttributes(unit.marks, !!unit.atom)]));
}

function storedUnits(script: NativeScript, beat: string, cell: "narration" | "visual"): string[] {
  const place = script.reader.narrationSpans(beat)[0];
  const items = cell === "visual"
    ? (script.roots.visuals.get(beat)?.toDelta() ?? []) as NativeDeltaItem[]
    : place ? nativeSegmentSpans(script.roots.segments.get(place.segment))?.[place.span]?.items ?? [] : [];
  return items.flatMap(item => {
    const attributes = [...new Set(Object.entries(item.attributes ?? {}).filter(([, value]) => value === true).map(([key]) => key.startsWith("t:") ? nativeMarkName(key) : key))].sort();
    if (typeof item.insert === "string") return Array.from(item.insert, text => sortedJson([text, attributes]));
    const embed = item.insert as Record<string, unknown>;
    return [sortedJson([typeof embed.img === "string" ? { img: JSON.parse(embed.img) as unknown } : embed, attributes])];
  });
}

function check(scripts: readonly NativeScript[], expected: ReadonlyMap<string, Run[]>, read: Reading): void {
  for (const script of scripts) for (const row of tape.document.rows) {
    const shown = read(script, row.id);
    assert.ok(shown, `copy ${script.doc.clientID} lost row ${row.id}`);
    assert.deepEqual(unitKeys(shown.narration), shownKeys(expected.get(row.id + "/narration") ?? []), `copy ${script.doc.clientID}, ${row.id} narration`);
    assert.deepEqual(unitKeys(shown.visual), shownKeys(expected.get(row.id + "/visual") ?? []), `copy ${script.doc.clientID}, ${row.id} visual`);
    for (const cell of ["narration", "visual"] as const) {
      assert.deepEqual(storedUnits(script, row.id, cell), requestedUnits(expected.get(row.id + "/" + cell) ?? []), `copy ${script.doc.clientID}, ${row.id} ${cell} stored attributes`);
    }
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
    if (at !== mute) assert.equal(edit(writer, op.target, op.from, op.to, op.insert).kind, "written", `op ${at} refused`);
    const row = read(writer, op.target.beat);
    assert.deepEqual(unitKeys((op.target.cell === "narration" ? row?.narration : row?.visual) ?? []), shownKeys(units), `op ${at}: ${op.target.beat} ${op.target.cell}`);
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
    for (const script of scripts) assert.deepEqual([script.reader.unplaced(), script.reader.problems()], [[], []]);
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

test("control: a stored attribute the commands did not ask for is caught, though the display hides it", () => {
  const { scripts, expected } = runTape("forward"), copy = scripts[0] as NativeScript, row = tape.document.rows[0];
  assert.ok(row);
  assert.ok([...expected.values()].some(runs => requestedUnits(runs).some(unit => !unit.endsWith(",[]]"))));
  const visual = copy.roots.visuals.get(row.id);
  assert.ok(visual && visual.length > 0);
  visual.format(0, 1, { "c:never-asked": null, "x-unknown": true });
  assert.throws(() => { check([copy], expected, honest); }, /stored attributes/);
});

test("the tape types every unit it counts", () => {
  const units = tape.source.rows.reduce((sum, row) => sum + unitsOf(cells(String(row.audioText ?? ""))).length + unitsOf(cells(String(row.visualText ?? ""))).length, 0);
  assert.ok(units > 0 && tape.ops.filter(op => op.op === "splice").length >= units);
});
