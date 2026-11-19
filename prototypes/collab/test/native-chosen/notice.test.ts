import assert from "node:assert/strict";
import test from "node:test";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import { base, load, outline, seed, sync } from "./kit.ts";
import { perform, sceneMap, shown } from "./play.ts";
import type { Cmd } from "./play.ts";

interface BeatReading { narration: string; visual: string; fields: Record<string, unknown>; scene: string | null; row: string }
type Reading = Map<string, BeatReading>;

// why: the plain reading the app keeps per beat id; ranks and joins are layout, not something a person wrote
function reading(replica: ChosenReplica): Reading {
  const view = shown(replica), scenes = sceneMap(view), result: Reading = new Map();
  for (const [row, members] of view.rows) for (const id of members) {
    const fields = { ...replica.beats.get(id)?.toJSON() };
    delete fields.e10Rank; delete fields.joined;
    result.set(id, { narration: view.audio.get(id) ?? "", visual: view.visual.get(id) ?? "", fields, scene: scenes.get(id) ?? null, row });
  }
  return result;
}

const added = (before: string, after: string): string[] => {
  const left = [...before];
  return [...after].filter(char => { const at = left.indexOf(char); if (at < 0) return true; left.splice(at, 1); return false; });
};

// why: the check the app would run on reconnecting, written from the plan's words; it never reads the replica
function notices(was: Reading, mine: Reading, now: Reading): string[] {
  const told: string[] = [], everywhere = [...now.values()].map(item => item.narration).join("");
  for (const [id, item] of mine) {
    const old = was.get(id), merged = now.get(id);
    const typed = added(old?.narration ?? "", item.narration), drew = added(old?.visual ?? "", item.visual);
    const fields = Object.keys(item.fields).filter(key => JSON.stringify(item.fields[key]) !== JSON.stringify(old?.fields[key]));
    const changed = !old || typed.length > 0 || drew.length > 0 || fields.length > 0 || old.scene !== item.scene;
    if (!changed) continue;
    if (!merged) {
      const kept = typed.filter(char => everywhere.includes(char)), where = [...now].find(([, other]) => typed.some(char => other.narration.includes(char)))?.[1].row;
      told.push(`${id} you ${old ? "changed" : "made"} is gone${drew.length ? ", with your visual text" : ""}${fields.length ? ", with your fields" : ""}`);
      if (kept.length) told.push(`your narration from ${id} now shows in row ${where ?? "?"}`);
      if (typed.length > kept.length) told.push(`your narration from ${id} shows in no row`);
      continue;
    }
    if (typed.some(char => !merged.narration.includes(char))) told.push(`${id}: some of your narration moved`);
    if (drew.some(char => !merged.visual.includes(char))) told.push(`${id}: some of your visual text is gone`);
    for (const key of fields) if (JSON.stringify(merged.fields[key]) !== JSON.stringify(item.fields[key])) told.push(`${id}: your ${key} was replaced`);
    if (old && old.scene !== item.scene && merged.scene !== item.scene) told.push(`${id}: your move to another scene did not hold`);
  }
  return told;
}

interface Case { name: string; lost: string; before?: ["away" | "here", Cmd][]; offline: Cmd[]; online: Cmd[]; told: { offline: string[]; online: string[] }; rows?: string[] }

function run(item: Case): { offline: string[]; online: string[]; rows: string[] } {
  const bytes = seed(base()), [away, here] = [load(bytes, 1), load(bytes, 2)] as [ChosenReplica, ChosenReplica];
  try {
    for (const [by, cmd] of item.before ?? []) perform(by === "away" ? away : here, cmd);
    sync([away, here]); away.changes(); here.changes();
    const was = reading(away);
    for (const cmd of item.offline) perform(away, cmd);
    for (const cmd of item.online) perform(here, cmd);
    const mine = reading(away), theirs = reading(here);
    sync([away, here]); away.changes(); here.changes();
    const now = reading(away);
    return { offline: notices(was, mine, now), online: notices(was, theirs, now), rows: outline(away).slice(0, 5) };
  } finally { away.destroy(); here.destroy(); }
}

const del = (row: string): Cmd => ({ op: "delete", rows: [row] });
const draw = (id: string, text: string): Cmd => ({ op: "type", id, field: "visual", at: 0, text });
const say = (id: string, text: string): Cmd => ({ op: "type", id, field: "audio", at: 1, text });
const field = (id: string): Cmd => ({ op: "field", id, key: "status", value: "ready" });
const split: Cmd = { op: "split", id: "B", at: 1, created: "N" };

// why: the online column is what the same check would say if it also ran on the copy that stayed online; the plan
// runs it only on the copy that comes back, so in the plan the online person is told nothing
const CASES: Case[] = [
  { name: "deleter offline, typist online, visual text", lost: "V", offline: [del("B")], online: [draw("B", "V")], told: { offline: [], online: ["B you changed is gone, with your visual text"] } },
  { name: "typist offline, deleter online, visual text", lost: "V", offline: [draw("B", "V")], online: [del("B")], told: { offline: ["B you changed is gone, with your visual text"], online: [] } },
  { name: "deleter offline, typist online, a field", lost: "status", offline: [del("B")], online: [field("B")], told: { offline: [], online: ["B you changed is gone, with your fields"] } },
  { name: "field setter offline, deleter online", lost: "status", offline: [field("B")], online: [del("B")], told: { offline: ["B you changed is gone, with your fields"], online: [] } },
  { name: "deleter offline, typist online, narration", lost: "nothing: rule a shows X in row A", offline: [del("B")], online: [say("B", "X")], told: { offline: [], online: ["B you changed is gone", "your narration from B now shows in row A"] } },
  { name: "typist offline, deleter online, narration", lost: "nothing: rule a shows X in row A", offline: [say("B", "X")], online: [del("B")], told: { offline: ["B you changed is gone", "your narration from B now shows in row A"], online: [] } },
  { name: "creator offline undoes a split, typist online draws in the new beat", lost: "V", before: [["away", split]], offline: [{ op: "undo" }], online: [draw("N", "V")], told: { offline: [], online: ["N you changed is gone, with your visual text"] } },
  { name: "typist offline draws in the new beat, creator online undoes the split", lost: "V", before: [["here", split]], offline: [draw("N", "V")], online: [{ op: "undo" }], told: { offline: ["N you changed is gone, with your visual text"], online: [] } },
  { name: "splitter offline, mover online, same beat", lost: "nothing: the second half stays at the old place", offline: [split], online: [{ op: "move", drop: { unit: "row", first: "B", target: "D", after: true } }], told: { offline: [], online: [] }, rows: ["A: abc / 1", "N: ef / ", "C: ghi / 3", "D: jkl / 4", "B: d / 2"] },
  { name: "two people drop rows into each other's place", lost: "nothing: neither order is the one asked for", offline: [{ op: "move", drop: { unit: "row", first: "A", target: "C", after: true } }], online: [{ op: "move", drop: { unit: "row", first: "C", target: "A", after: false } }], told: { offline: [], online: [] }, rows: ["C: ghi / 3", "B: def / 2", "A: abc / 1", "D: jkl / 4", "#H mno"] },
  { name: "both delete a row, then both undo apart", lost: "nothing: the narration shows twice", before: [["away", del("B")], ["here", del("B")]], offline: [{ op: "undo" }], online: [{ op: "undo" }], told: { offline: [], online: [] }, rows: ["A: abc / 1", "B: defdef / 2", "C: ghi / 3", "D: jkl / 4", "#H mno"] },
  { name: "typist offline, scene deleted online (never acceptable)", lost: "Ω, kept only in the removed heading's name", offline: [say("E", "Ω")], online: [del("E"), { op: "removeHeading", id: "H" }], told: { offline: ["E you changed is gone", "your narration from E shows in no row"], online: [] } },
  { name: "scene deleter offline, typist online (never acceptable)", lost: "Ω, kept only in the removed heading's name", offline: [del("E"), { op: "removeHeading", id: "H" }], online: [say("E", "Ω")], told: { offline: [], online: ["E you changed is gone", "your narration from E shows in no row"] } }
];

test("E11 offline notice: what the check on three plain readings tells the person coming back, and the known gap", t => {
  const rows = CASES.map(item => ({ name: item.name, lost: item.lost, ...run(item) }));
  for (const row of rows) t.diagnostic(JSON.stringify(row));
  for (const [index, item] of CASES.entries()) {
    const row = rows[index];
    assert.deepEqual({ offline: row?.offline, online: row?.online }, item.told, item.name);
    if (item.rows) assert.deepEqual(row?.rows, item.rows, `${item.name}: the merged rows`);
  }
  // why: the known gap, confirmed: with the deleter offline and the typist online, the returning copy's check is silent
  for (const name of ["deleter offline, typist online, visual text", "deleter offline, typist online, a field", "creator offline undoes a split, typist online draws in the new beat"]) {
    assert.deepEqual(rows.find(row => row.name === name)?.offline, [], name);
  }
});
