import { isDeepStrictEqual as equal } from "node:util";
import * as Y from "yjs";
import type { ChosenReplica } from "../../src/native-chosen/replica.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { shown } from "../native-chosen/play.ts";
import type { StorageCheck } from "../native-chosen/play.ts";

// why: options C and D store a rank as several entries; what they hold is read from storage under the option's names
function entries(option: RankOption, record: Y.Map<unknown>): unknown[] {
  if (option === "D") { const list = record.get("ranks"); return list instanceof Y.Array ? list.toArray() : []; }
  return [...record.entries()].filter(([key]) => key.startsWith("rank:")).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value]);
}

export const liveCount = (option: RankOption, now: unknown[]): number =>
  option === "D" ? now.filter(value => typeof value === "string").length : now.filter(entry => typeof (entry as [string, unknown])[1] === "string").length;

export function held(option: RankOption, replica: ChosenReplica): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>();
  if (option !== "C" && option !== "D") return found;
  for (const [root, map] of [["b", replica.beats], ["h", replica.headings]] as const) for (const [id, record] of map) found.set(`${root}:${id}`, entries(option, record));
  return found;
}

const KEEPS_ORDER = new Set(["type", "erase", "format", "field"]);
const order = (replica: ChosenReplica): string[] => shown(replica).order.map(id => id.replace(/^~stray.*$/, "~stray"));

interface Snap { held: Map<string, unknown[]>; order: string[] }

// why: two rules the rows of one command cannot show: a command that edits text or a field keeps every row in place,
// and in options C and D a rank write other than an undo or redo leaves exactly one live entry
export function e15Checks(option: RankOption): StorageCheck {
  return {
    snap: (replica): Snap => ({ held: held(option, replica), order: order(replica) }),
    check: (before, replica, cmd) => {
      const was = before as Snap, problems: string[] = [];
      if (KEEPS_ORDER.has(cmd.op) && !equal(order(replica), was.order)) problems.push(`${cmd.op} moved rows: ${was.order.join(",")} became ${order(replica).join(",")}`);
      if (cmd.op === "undo" || cmd.op === "redo") return problems;
      for (const [key, now] of held(option, replica)) {
        if (equal(was.held.get(key), now)) continue;
        const live = liveCount(option, now);
        if (live !== 1) problems.push(`rank of ${key} holds ${live} live entries after a rank write`);
      }
      return problems;
    }
  };
}
