import { advanceChosen } from "../native-chosen/model.ts";
import { blocks, merge } from "../native-delete/model.ts";
import type { DeleteHistory } from "../native-delete/histories.ts";
import type { DeleteCommand, StoredReading } from "../native-delete/model.ts";

export interface ForkExpectation {
  stored: StoredReading;
  names: Record<string, string>;
}

function separateNames(stored: StoredReading): ForkExpectation {
  const next = structuredClone(stored), names = Object.fromEntries(Object.keys(stored.headings).map(id => [id, ""]));
  for (const segment of Object.values(next.segments)) {
    let name = segment.head?.kind === "h" ? segment.head.id : null;
    segment.units = segment.units.filter(unit => {
      if (typeof unit !== "string") {
        name = unit.kind === "h" ? unit.id : null;
        return true;
      }
      if (name === null) return true;
      names[name] += unit;
      return false;
    });
  }
  return { stored: next, names };
}

// why: the E11 plain model cuts narration and drops containers in one step. Restore just those plain maps for
// the kept case before each fork is merged. Headings stay flagged, and names merge as independent text.
function advance(before: StoredReading, command: DeleteCommand, keep: boolean): StoredReading {
  const next = advanceChosen(before, command);
  if (keep && (command.op === "rows" || command.op === "scene")) {
    next.beats = structuredClone(before.beats);
    next.visuals = { ...before.visuals };
  }
  if (command.op === "split" || command.op === "insert") next.beats[command.created] = {};
  return next;
}

export function predictForks(history: DeleteHistory, keep: boolean): { forks: ForkExpectation[][]; settled: ForkExpectation[] } {
  const initial = separateNames(history.initial);
  const forks = history.forks.map(commands => {
    let state = history.initial;
    return commands.map(cmd => {
      state = advance(state, cmd, keep);
      return separateNames(state);
    });
  });
  const end = forks.map(fork => fork.at(-1) ?? initial);
  const names = Object.assign({}, initial.names, ...end.map(fork =>
    Object.fromEntries(Object.entries(fork.names).filter(([id, text]) => text !== initial.names[id])))) as Record<string, string>;
  return { forks, settled: merge(initial.stored, end.map(fork => fork.stored)).map(stored => ({ stored, names })) };
}

export function forkEdits(history: DeleteHistory, stored: StoredReading): { status: number; visual: number } {
  const alive = new Set(blocks(stored).filter(block => block.kind === "b").map(block => block.id));
  let status = 0, visual = 0;
  for (const command of history.forks.flat()) {
    if (command.op === "field" && !alive.has(command.id) && stored.beats[command.id]?.status === command.value) status++;
    if (command.op === "type" && command.field === "visual" && !alive.has(command.id) && stored.visuals[command.id]?.includes(command.value)) visual++;
  }
  return { status, visual };
}
