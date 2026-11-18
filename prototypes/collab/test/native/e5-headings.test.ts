import assert from "node:assert/strict";
import test from "node:test";
import { NativeHeadingReplica } from "../../src/native/headings.ts";
import { DELIVERIES, generateHistory, NAMED, recordHistory, WITH_RESTORE } from "./e5-histories.ts";
import { loadReplica, readProjection, readStored, runHistory, seedReplica, WRITES } from "./e5-run.ts";
import type { E5Run } from "./e5-run.ts";

const REMOVALS = ["delete", "flag"] as const;
const SEEDS = 200;

function summary(run: E5Run): string[] {
  if (!run.final) return [];
  const { outline, removedHeadings } = run.final.view;
  return [...outline.map(entry => entry.kind === "row" ? `${entry.members.join("+")}: ${entry.audio}` : `#${entry.id}: ${entry.name}`),
    ...removedHeadings.map(entry => `recovery ${entry.id}: ${entry.name}`)];
}

const COMMON = ["#H0: A", "B0: O"];
const END = ["B3: gh", "B4: ij"];
const COMMON_NAMES: Readonly<Record<string, { delete: string[]; flag: string[]; stranded?: number }>> = {
  "remove an embedded heading against rename typing": {
    delete: [...COMMON, "B1: bcDX", "B2: ef", ...END], flag: [...COMMON, "B1: bc", "B2: ef", ...END, "recovery H1: DX"]
  },
  "remove a heading against rename deletion": {
    delete: [...COMMON, "B1: bc", "B2: ef", ...END], flag: [...COMMON, "B1: bc", "B2: ef", ...END, "recovery H1: "]
  },
  "remove a heading against splitting the beat directly below": {
    delete: [...COMMON, "B1: bcD", "B2: e", "S2: f", ...END], flag: [...COMMON, "B1: bc", "B2: e", "S2: f", ...END, "recovery H1: D"]
  },
  "remove a heading against splitting the beat directly above": {
    delete: [...COMMON, "B1: b", "S2: cD", "B2: ef", ...END], flag: [...COMMON, "B1: b", "S2: c", "B2: ef", ...END, "recovery H1: D"]
  },
  "remove a heading against joining the beat directly below": {
    delete: [...COMMON, "B1+B2: bcD ef", ...END], flag: [...COMMON, "B1+B2: bc ef", ...END, "recovery H1: D"]
  },
  "remove a heading against joining the beat directly above": {
    delete: ["#H0: A", "B0+B1: O bcD", "B2: ef", ...END], flag: ["#H0: A", "B0+B1: O bc", "B2: ef", ...END, "recovery H1: D"]
  },
  "create two headings above the same embedded beat": {
    delete: [...COMMON, "B1: bc", "#H1: D", "B2: ef", "#Left: X", "#Right: Y", ...END],
    flag: [...COMMON, "B1: bc", "#H1: D", "B2: ef", "#Left: X", "#Right: Y", ...END]
  },
  "create two headings above the same segment-head beat": {
    delete: [...COMMON, "B1: bc", "#H1: D", "B2: ef", "B3: gh", "#Left: X", "#Right: Y", "B4: ij"],
    flag: [...COMMON, "B1: bc", "#H1: D", "B2: ef", "B3: gh", "#Left: X", "#Right: Y", "B4: ij"]
  },
  "remove the same embedded heading twice": {
    delete: [...COMMON, "B1: bcD", "B2: ef", ...END], flag: [...COMMON, "B1: bc", "B2: ef", ...END, "recovery H1: D"]
  },
  "remove the same segment-head heading twice": {
    delete: ["B0: O", "B1: bc", "#H1: D", "B2: ef", ...END], flag: ["B0: O", "B1: bc", "#H1: D", "B2: ef", ...END, "recovery H0: A"], stranded: 1
  },
  "remove a segment-head heading against typing at the start of its first beat": {
    delete: ["B0: XO", "B1: bc", "#H1: D", "B2: ef", ...END], flag: ["B0: XO", "B1: bc", "#H1: D", "B2: ef", ...END, "recovery H0: A"], stranded: 1
  },
  "remove a segment-head heading against typing in its name": {
    delete: ["B0: O", "B1: bc", "#H1: D", "B2: ef", ...END], flag: ["B0: O", "B1: bc", "#H1: D", "B2: ef", ...END, "recovery H0: XA"], stranded: 2
  },
  "a new heading boundary races a rename at the end of the removed name": {
    delete: ["#New: YX", "B0: O", "B1: bc", "#H1: D", "B2: ef", ...END],
    flag: ["#New: YX", "B0: O", "B1: bc", "#H1: D", "B2: ef", ...END, "recovery H0: A"], stranded: 1
  }
};
const RESTORED_NAMES: Readonly<Record<string, string[]>> = {
  "restore exposes the renamed heading for editing in place": [...COMMON, "B1: bc", "#H1: X", "B2: ef", ...END],
  "restoring a segment-head heading exposes the whole name at its original position": ["#H0: XA", "B0: O", "B1: bc", "#H1: D", "B2: ef", ...END],
  "restore that saw only the lower-priority removal leaves the concurrent removal standing": [...COMMON, "B1: bc", "B2: ef", ...END, "recovery H1: D"]
};

for (const removal of REMOVALS) for (const [name, steps] of Object.entries(removal === "flag" ? { ...NAMED, ...WITH_RESTORE } : NAMED)) {
  test(`E5 ${removal}: ${name}`, () => {
    const history = recordHistory(removal, 2, (_, at) => steps[at]);
    for (const delivery of DELIVERIES) {
      const result = runHistory(history, removal, delivery, 7);
      assert.equal(result.mismatch, undefined, JSON.stringify(result.mismatch));
      const literal = COMMON_NAMES[name];
      assert.deepEqual(summary(result), literal?.[removal] ?? RESTORED_NAMES[name]);
      assert.equal(result.uneditable, removal === "delete" ? literal?.stranded ?? 0 : 0);
      assert.equal(result.lost + result.duplicated + result.disagreeing + result.outOfOrder + result.crashes, 0);
    }
  });
}

for (const removal of REMOVALS) {
  const histories = Array.from({ length: SEEDS }, (_, seed) => generateHistory(removal, (seed + 1) * 7919, 30));
  test(`E5 ${removal}: generated heading and beat races`, t => {
    const totals = { histories: 0, commands: 0, lost: 0, duplicated: 0, uneditable: 0, disagreeing: 0, outOfOrder: 0, crashes: 0, strandedHistories: 0 };
    const locations: Record<string, number> = {}, commands: Record<string, number> = {};
    for (const delivery of DELIVERIES) for (const [seed, history] of histories.entries()) {
      const result = runHistory(history, removal, delivery, seed + 1);
      assert.equal(result.mismatch, undefined, JSON.stringify({ seed: seed + 1, delivery, mismatch: result.mismatch }));
      totals.histories++;
      totals.commands += history.events.length;
      for (const key of ["lost", "duplicated", "uneditable", "disagreeing", "outOfOrder", "crashes"] as const) totals[key] += result[key];
      if (result.uneditable) totals.strandedHistories++;
      for (const [where, count] of Object.entries(result.renameLocations)) locations[where] = (locations[where] ?? 0) + count;
      for (const { command } of history.events) {
        const key = "field" in command ? `${command.op} ${command.field}` : command.op;
        commands[key] = (commands[key] ?? 0) + 1;
      }
    }
    t.diagnostic(JSON.stringify({ totals, commands, locations }));
    assert.equal(totals.histories, 1000);
    assert.equal(totals.lost + totals.duplicated + totals.disagreeing + totals.outOfOrder + totals.crashes, 0);
    if (removal === "delete") assert.ok(totals.uneditable > 0);
    else assert.equal(totals.uneditable, 0);
    assert.ok((commands.unjoin ?? 0) > 135);
  });

  for (const op of WRITES) {
    if (removal === "delete" && op === "restoreHeading") continue;
    test(`E5 ${removal}: generated check detects a silent ${op}`, t => {
      let used = 0, failed = 0;
      for (const delivery of DELIVERIES) for (const [seed, history] of histories.entries()) {
        const at = history.steps.findIndex(step => "command" in step && step.command.op === op);
        if (at < 0) continue;
        used++;
        const result = runHistory(history, removal, delivery, seed + 1, op);
        if (result.mismatch?.op === op && result.mismatch.at === at && !result.crashes) failed++;
        else assert.fail(JSON.stringify({ seed: seed + 1, delivery, op, at, result }));
      }
      t.diagnostic(`${op}: ${used} histories use it, ${failed} fail when it is silent`);
      assert.ok(used > 0);
      assert.equal(failed, used);
    });
  }
}

test("E5 deletion: a surviving embedded name can be edited in narration", () => {
  const replica = seedReplica("delete");
  try {
    replica.removeHeading("H1");
    const row = replica.rows().find(item => item.id === "B1");
    assert.equal(row?.audioText, "bcD");
    replica.splice("B1", "audioText", 2, 3, [{ text: "Z", marks: {} }]);
    assert.equal(replica.rows().find(item => item.id === "B1")?.audioText, "bcZ");
  } finally { replica.destroy(); }
});

test("E5 deletion: a deleted head has a stored name but no editor or restore", () => {
  const replica = seedReplica("delete");
  try {
    replica.removeHeading("H0");
    assert.equal(readStored(replica).segments.S0?.units[0], "A");
    assert.ok(!readProjection(replica).outline.some(item => item.kind === "heading" && item.id === "H0"));
    assert.deepEqual(replica.headingRecovery(), []);
    assert.throws(() => replica.restoreHeading("H0"), /no recovery entry/);
    assert.throws(() => replica.typeHeading("H0", 0, "X"), /Missing beat/);
  } finally { replica.destroy(); }
});

test("E5 flag: hydrate, remove and restore a heading that has its own segment", () => {
  const replica = new NativeHeadingReplica(1, "flag");
  try {
    replica.hydrate({
      sections: [{ id: "H1", name: "Title", firstSceneId: "B1", extra: "kept" }],
      rows: [{ id: "B1", audioText: "Narration" }]
    });
    assert.deepEqual(replica.headings.get("H1")?.toJSON(), { extra: "kept" });
    replica.removeHeading("H1");
    assert.deepEqual(readProjection(replica).removedHeadings, [{ kind: "heading", id: "H1", name: "Title" }]);
    replica.restoreHeading("H1");
    assert.deepEqual(readProjection(replica).outline[0], { kind: "heading", id: "H1", name: "Title" });
    assert.deepEqual(replica.headings.get("H1")?.toJSON(), { extra: "kept" });
  } finally { replica.destroy(); }
});

function storedBytes(replica: NativeHeadingReplica): number {
  const reloaded = loadReplica(replica.headingRemoval, 800, replica.encode());
  try { return reloaded.encode().byteLength; } finally { reloaded.destroy(); }
}

test("E5 stored bytes for isolated commands and repeated cycles", t => {
  const measures: Record<string, unknown>[] = [];
  for (const removal of REMOVALS) for (const [placement, beat] of [["embed", "B3"], ["head", "B4"]] as const) {
    const replica = seedReplica(removal);
    try {
      const base = storedBytes(replica);
      replica.createHeading(beat, "H100", "Q");
      const created = storedBytes(replica);
      replica.typeHeading("H100", 1, "R");
      const typed = storedBytes(replica);
      replica.deleteHeadingText("H100", 1, 2);
      const deleted = storedBytes(replica);
      replica.removeHeading("H100");
      const removed = storedBytes(replica);
      const fresh = seedReplica(removal);
      let cycles: number;
      let retained: { records: number; segments: number; letters: number; flags: number };
      try {
        for (let index = 0; index < 1000; index++) {
          const id = `H${1000 + index}`;
          fresh.createHeading(beat, id, "Q");
          fresh.removeHeading(id);
        }
        cycles = storedBytes(fresh) - base;
        const stored = readStored(fresh);
        retained = {
          records: Object.keys(stored.headings).length - 2,
          segments: stored.order.length - 2,
          letters: Object.values(stored.segments).flatMap(segment => segment.units).filter(unit => unit === "Q").length,
          flags: Object.values(stored.headings).filter(Boolean).length
        };
      } finally { fresh.destroy(); }
      measures.push({ removal, placement, base, create: created - base, type: typed - created, deleteText: deleted - typed,
        remove: removed - deleted, cycles, retained });
      assert.equal(retained.letters, 1000);
      assert.equal(retained.records, 1000);
      assert.equal(retained.flags, removal === "flag" ? 1000 : 0);
    } finally { replica.destroy(); }
  }
  const replica = seedReplica("flag");
  try {
    const base = storedBytes(replica);
    for (let index = 0; index < 1000; index++) {
      replica.removeHeading("H1");
      replica.restoreHeading("H1");
    }
    t.diagnostic(JSON.stringify({ measures, removeRestoreBytes: storedBytes(replica) - base }));
  } finally { replica.destroy(); }
});
