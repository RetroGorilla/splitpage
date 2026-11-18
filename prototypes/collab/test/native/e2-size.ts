import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { NativeReplica } from "../../src/native/variant.ts";
import { joinUp, removeRow, restoreRow, splitAt } from "../../src/native/rows.ts";

export interface E2SizeRow {
  schedule: string; cycles: number; commandsPerCycle: number; base: number; editing: number; stored: number;
  bytesPerCycle: number; bytesPerCommand: number; hiddenRecords: number; hiddenVisuals: number; flagItems: number;
}

const LINE = "The narration of one beat runs to about fifty-seven chars.";
const SCRIPT = Array.from({ length: 4 }, (_, index) => ({
  id: `R${index + 1}`, audioText: index ? LINE : LINE.repeat(40), visualText: "A visual cell of about thirty."
}));

function stored(replica: NativeReplica): number {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, replica.encode());
  const size = Y.encodeStateAsUpdate(fresh).byteLength;
  fresh.destroy();
  return size;
}

function flagItems(replica: NativeReplica): number {
  let count = 0;
  for (const [, record] of replica.beats) for (const key of ["joined", "removed"]) {
    let item = (record as unknown as { _map: Map<string, Y.Item> })._map.get(key) ?? null;
    while (item) { count += item.length; item = item.left as Y.Item | null; }
  }
  return count;
}

// why: each schedule repeats one structural round on the same beats of one copy; the stored size is read from a fresh
// copy loaded from the encoded state, as the spike's report measures a copy without undo history
const SCHEDULES: Record<string, { commands: number; round: (replica: NativeReplica, cycle: number) => void }> = {
  "split row R1 inside its longest beat, then join the new beat back": {
    commands: 2,
    round: (replica, cycle) => {
      const row = replica.rows().find(candidate => candidate.id === "R1");
      let at = 0, best = { start: 0, length: 0 };
      for (const part of row?.parts.audio ?? []) { if (part.beat !== null && part.length > best.length) best = { start: at, length: part.length }; at += part.length; }
      if (splitAt(replica, "R1", best.start + Math.floor(best.length / 2), `S${cycle}`) !== "split" || !joinUp(replica, `S${cycle}`)) throw new Error(`Round ${cycle} did not split and join`);
    }
  },
  "split R1 inside its longest beat, no join": {
    commands: 1,
    round: (replica, cycle) => {
      let best = { beat: "R1", length: 0 };
      for (const row of replica.rows()) if (row.id === "R1" || row.id.startsWith("S")) {
        const length = row.parts.audio.reduce((sum, part) => sum + part.length, 0);
        if (length > best.length) best = { beat: row.id, length };
      }
      if (splitAt(replica, best.beat, Math.floor(best.length / 2), `S${cycle}`) !== "split") throw new Error(`Round ${cycle} did not split`);
    }
  },
  "join R3 to R2, then split at the seam": {
    commands: 2,
    round: replica => {
      if (!joinUp(replica, "R3") || splitAt(replica, "R2", LINE.length, "unused") !== "unjoined") throw new Error("The round did not join and unjoin");
    }
  },
  "remove R2, then restore it": {
    commands: 2,
    round: replica => { removeRow(replica, "R2", "Someone"); restoreRow(replica, "R2"); }
  },
  "split inside R1, then delete the new boundary (question 4)": {
    commands: 2,
    round: (replica, cycle) => {
      replica.split("R1", 20, `S${cycle}`);
      const block = replica.block(`S${cycle}`), text = replica.segments.get(block.segment)?.get("text") as Y.Text;
      replica.transact(() => { text.delete(block.start - 1, 1); });
      replica.changes();
    }
  }
};

export function measureE2Size(cycles: number): E2SizeRow[] {
  return Object.entries(SCHEDULES).map(([schedule, plan]) => {
    const replica = new NativeReplica(1);
    replica.hydrate({ rows: SCRIPT });
    const base = stored(replica);
    for (let cycle = 1; cycle <= cycles; cycle++) plan.round(replica, cycle);
    const rows = replica.rows(), placed = new Set(rows.flatMap(row => row.members)), size = stored(replica);
    const hiddenRecords = [...replica.beats.keys()].filter(beat => !placed.has(beat) || rows.every(row => row.id !== beat)).length;
    const hiddenVisuals = [...replica.visuals.keys()].filter(beat => !placed.has(beat) || rows.every(row => row.id !== beat)).length;
    const result: E2SizeRow = {
      schedule, cycles, commandsPerCycle: plan.commands, base, editing: replica.encode().byteLength, stored: size,
      bytesPerCycle: Math.round(((size - base) / cycles) * 100) / 100, bytesPerCommand: Math.round(((size - base) / cycles / plan.commands) * 100) / 100,
      hiddenRecords, hiddenVisuals, flagItems: flagItems(replica)
    };
    replica.destroy();
    return result;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cycles = Number(process.argv.find(value => value.startsWith("--cycles="))?.split("=")[1] ?? 1000);
  console.log(JSON.stringify(measureE2Size(cycles), null, 2));
}
