import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import * as Y from "yjs";
import { isProjectionEntry } from "../../proj/entry.ts";
import { lifetimeSize, lifetimeTyped } from "./counts.ts";
import { lifetimeSources } from "./source.ts";
import { canonicalLifetimeSource, defaultLifetimeInterventions, LifetimeHistory, lifetimePlan } from "./workload.ts";
import type { LifetimeInterventions } from "./workload.ts";

export const lifetimeSensitivityCases: { name: string; overrides: Partial<LifetimeInterventions> }[] = [
  { name: "baseline", overrides: {} },
  { name: "double status changes", overrides: { statusesPerBeat: 4 } },
  { name: "double corrections", overrides: { correctionsPer55: 2 } },
  { name: "double removals", overrides: { removals: 4 } },
  { name: "double revised beats", overrides: { revisionBeats: 10 } }
];

export function collectLifetimeSensitivity() {
  const source = lifetimeSources(), base = canonicalLifetimeSource();
  const rows = lifetimeSensitivityCases.map(({ name, overrides }) => {
    const history = new LifetimeHistory(2, base, false, overrides), checkpoints: { blocks: number; encodedBytes: number; typedCharacters: number }[] = [];
    const crossing: { first: { block: number; encodedBytes: number; typedCharacters: number; finalCharacters: number } | null } = { first: null };
    history.onStep = () => {
      const encodedBytes = Y.encodeStateAsUpdate(history.master.doc).length;
      if (!crossing.first && encodedBytes >= lifetimePlan.capBytes) crossing.first = { block: history.blocks + 1, encodedBytes,
        typedCharacters: lifetimeTyped(history.operations), finalCharacters: lifetimeSize(history.master).finalCharacters };
    };
    try {
      while (!crossing.first && history.blocks < lifetimePlan.maxBlocks) {
        history.appendBlock(); checkpoints.push({ blocks: history.blocks, encodedBytes: Y.encodeStateAsUpdate(history.master.doc).length, typedCharacters: lifetimeTyped(history.operations) });
      }
      assert.ok(crossing.first);
      return { name, writers: 2, parameters: { ...defaultLifetimeInterventions, ...overrides }, firstCap: crossing.first, operations: { ...history.operations }, checkpoints };
    } finally { history.destroy(); }
  });
  assert.deepEqual(lifetimeSources(), source, "Sources changed during sensitivity counts");
  return { source, method: "One parameter doubled at a time; two writers; same generator, fixture, delivery, GC, pictures and remaining interventions; bytes checked after each edit group; no clock.", rows };
}

export function readLifetimeSensitivity(): ReturnType<typeof collectLifetimeSensitivity> {
  return JSON.parse(readFileSync(new URL("sensitivity.json", import.meta.url), "utf8")) as ReturnType<typeof collectLifetimeSensitivity>;
}

if (isProjectionEntry(import.meta.url) && process.argv.includes("--write")) {
  const value = collectLifetimeSensitivity(); writeFileSync(new URL("sensitivity.json", import.meta.url), JSON.stringify(value, null, 2) + "\n");
  for (const row of value.rows) process.stdout.write(`${row.name}: first cap at block ${row.firstCap.block}\n`);
}
