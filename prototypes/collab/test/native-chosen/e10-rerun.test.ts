import assert from "node:assert/strict";
import { test } from "node:test";
import { DELIVERIES } from "../native/e5-histories.ts";
import { generate, namedHistories } from "../native-moves/e10-model.ts";
import type { E10Command, E10History, E10Step } from "../native-moves/e10-model.ts";
import { run as runE10 } from "../native-moves/e10-run.ts";
import { b, h } from "./kit.ts";
import type { Spec } from "./kit.ts";
import { play } from "./play.ts";
import type { Cmd, Controls, PlayResult, Step } from "./play.ts";

const strip = (id: string): string => id.replace(/^#/, "");

export const E10_SPEC = (): Spec => ({
  order: ["scene-P", "beat-D", "scene-Q"],
  segments: {
    "scene-P": { head: h("P"), units: ["x", b("A"), "ab", b("B"), "cd", b("C"), "ef"] },
    "beat-D": { head: b("D"), units: ["gh"] },
    "scene-Q": { head: h("Q"), units: ["y", b("E"), "ij", b("F"), "kl", b("G"), "mn", b("H"), "op"] }
  },
  beats: { A: { note: "one" }, B: { note: "two" }, C: { paragraphStart: true }, D: {}, E: {}, F: {}, G: {}, H: {} },
  visuals: { A: "A", B: "B", C: "C", D: "D", E: "E", F: "F", G: "G", H: "H" },
  headings: { P: {}, Q: {} }
});

export function translate(command: E10Command): Cmd {
  switch (command.op) {
    case "move": {
      const { drop } = command, scene = drop.unit === "scene";
      return { op: "move", drop: { ...drop, first: scene ? strip(drop.first) : drop.first, target: scene && drop.target ? strip(drop.target) : drop.target } };
    }
    case "type": return { op: "type", id: command.id, field: command.field === "audioText" ? "audio" : "visual", at: command.at, text: command.text };
    case "format": case "tag": return { op: "format", id: command.id, field: "audio", from: command.from, to: command.to, key: command.key, on: true };
    case "field": return { op: "field", id: command.id, key: command.key, value: command.value };
    case "split": return { op: "split", id: command.id, at: command.at, created: command.newId };
    case "join": case "unjoin": return { op: command.op, id: command.id };
    case "delete": return { op: "delete", rows: [command.id] };
    case "removeHeading": return { op: "removeHeading", id: strip(command.id) };
    case "heading": return { op: "heading", above: command.id, id: strip(command.newId), text: command.text };
    case "rename": return { op: "type", id: strip(command.id), field: "name", at: command.at, text: command.text };
    case "undo": case "redo": return { op: command.op };
  }
}

export const steps = (history: E10History): Step[] => history.steps.map((step: E10Step): Step => "from" in step ? step : { by: step.by, cmd: translate(step.command) });

function e10Outcome(history: E10History, writers: number): "preferred" | "other" | "broken" {
  const runs = DELIVERIES.map(delivery => runE10("flat", history, delivery, writers));
  if (runs.some(result => result.problems.length || result.local.length || !result.view)) return "broken";
  if (runs.some(result => result.preferences.length || (result.view && !history.preferred(result.view)))) return "other";
  return "preferred";
}

const all = (): { history: E10History; writers: number }[] => [
  ...namedHistories.map(history => ({ history, writers: 2 })),
  ...Array.from({ length: 200 }, (_, i) => ({ history: generate(i + 1), writers: 3 }))
];

function combine(results: PlayResult[]): { never: string[]; local: string[]; kinds: Record<string, number>; lines: string[] } {
  const kinds: Record<string, number> = {};
  for (const result of results) for (const [kind, n] of Object.entries(result.kinds)) kinds[kind] = Math.max(kinds[kind] ?? 0, n);
  return { never: [...new Set(results.flatMap(result => result.never))], local: [...new Set(results.flatMap(result => result.local))], kinds, lines: results[0]?.lines ?? [] };
}

test("E11 rerun of E10's 229 histories, flat ranks, five deliveries", t => {
  const table: Record<string, string[]> = {}, totals: Record<string, number> = {}, broken: Record<string, unknown> = {};
  let never = 0, local = 0;
  const localKinds: Record<string, number> = {}, samples: Record<string, string> = {}, adjacent: Record<string, { count: number; was: Record<string, number> }> = {};
  const tags = { requested: 0, kept: 0, lost: [] as unknown[] };
  let joinMoving: string[] = [];
  for (const [index, { history, writers }] of all().entries()) {
    const results = DELIVERIES.map((mode, at) => play({ spec: E10_SPEC(), steps: steps(history), writers, mode, seed: index * 5 + at }));
    const merged = combine(results);
    for (const line of results.map(result => result.lines.join(" | "))) assert.equal(line, merged.lines.join(" | "), `${history.label}: the five deliveries agree`);
    for (const kind of Object.keys(merged.kinds)) totals[kind] = (totals[kind] ?? 0) + 1;
    if (merged.never.length) never++;
    if (merged.local.length) local++;
    for (const problem of merged.local) { const key = problem.replace(/^step \d+ /, "").replace(/[^\p{L} ]|\b[A-Z]\b/gu, "").slice(0, 70); localKinds[key] = (localKinds[key] ?? 0) + 1; samples[key] ??= `${history.label}: ${problem}`; }
    const old = e10Outcome(history, writers), now = merged.never.length ? `never-acceptable: ${merged.never[0]}` : Object.keys(merged.kinds).join("; ") || "clean";
    if (old === "broken") broken[`${history.label}`] = { kind: history.kind, now, local: merged.local.slice(0, 2) };
    if (results.some(result => result.uses.adjacent)) {
      const slot = adjacent[history.kind] ??= { count: 0, was: {} };
      slot.count++; slot.was[old] = (slot.was[old] ?? 0) + 1;
    }
    if (history.label === "join moving") joinMoving = merged.lines;
    tags.requested += results[0]?.tags.requested ?? 0; tags.kept += results[0]?.tags.kept ?? 0;
    for (const result of results) if (result.tags.lost.length) { tags.lost.push({ label: history.label, lost: result.tags.lost }); break; }
    (table[`${old} -> ${merged.never.length ? "never-acceptable" : Object.keys(merged.kinds).length ? "accepted loss" : "clean"}`] ??= []).push(history.label);
  }
  t.diagnostic(JSON.stringify({ never, local, totals, transitions: Object.fromEntries(Object.entries(table).map(([key, labels]) => [key, labels.length])) }));
  t.diagnostic(JSON.stringify({ broken }));
  t.diagnostic(JSON.stringify({ localKinds, samples }));
  t.diagnostic(JSON.stringify({ adjacent, joinMoving, tags }));
  // why: E10 showed F and B as one row; rule d shows B as its own row, because B's join names A, not the beat above
  assert.deepEqual(joinMoving.slice(5, 8), ["E: ij / E", "F: kl / F", "B: cd / B"]);
  assert.equal(Object.keys(broken).length, 22, "E10 counted 22 broken flat histories");
  assert.deepEqual([never, local], [0, 0], "no never-acceptable result and every command does what it promises");
});

export type { Controls };
