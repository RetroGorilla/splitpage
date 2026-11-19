import type { Cmd } from "../../test/native-chosen/play.ts";
import type { LedgerEvent } from "../../test/native-chosen/ledger.ts";
import { rowOf, shown, standing } from "../../test/native-chosen/play.ts";
import type { ChosenReplica } from "../native-chosen/replica.ts";
import { readNotice } from "../native-notice/yjs.ts";

export const fieldLoss = "unseen record change discarded with a deleted beat";
export const visualLoss = "unseen visual change discarded with a deleted beat";
export const lossKinds = [
  fieldLoss, visualLoss,
  "typing in a new beat lost when its creator undoes the creation unseen",
  "typing in a new heading lost when its creator undoes the creation unseen",
  "a split at the same moment as a move left the second half at the old place",
  "a deletion missed a row that another person's unseen undo had restored",
  "a double delete then a double undo doubles the narration"
];

interface CrossedEdit {
  id: string; index: number; facet: "field" | "visual"; key: string; value: string;
}

export function crossedEdits(events: readonly LedgerEvent[], command: (index: number) => Cmd | undefined): CrossedEdit[] {
  return events.flatMap<CrossedEdit>(event => {
    const cmd = command(event.index);
    if (!cmd || (cmd.op !== "field" && !(cmd.op === "type" && cmd.field === "visual"))) return [];
    const id = cmd.id;
    const cuts = events.filter(cut => cut.by !== event.by && cut.deletedBeats.includes(id)
      && !cut.seen.has(event.index) && !event.seen.has(cut.index));
    if (!cuts.length || !standing(event.index, events)) return [];
    if (cmd.op === "field") {
      const writes = events.filter(other => other.fieldSet?.beat === id && other.fieldSet.key === cmd.key
        && standing(other.index, events));
      const latest = writes.filter(write => !writes.some(other => other.seen.has(write.index)))
        .sort((a, b) => b.by - a.by)[0];
      if (latest !== event) return [];
      return [{ id, index: event.index, facet: "field" as const, key: cmd.key, value: cmd.value }];
    }
    return [...cmd.text].flatMap(value => events.some(erase => erase.erased.includes(value)
      && standing(erase.index, events)) ? [] : [{ id, index: event.index, facet: "visual" as const, key: "", value }]);
  });
}

export function readCrossings(replica: ChosenReplica, edits: readonly CrossedEdit[],
  readVisual = (id: string) => replica.visuals.get(id)?.toString()) {
  const view = shown(replica), reading = new Map(readNotice(replica).map(beat => [beat.id, beat]));
  return edits.map(edit => {
    const live = rowOf(view, edit.id) !== undefined;
    const row = reading.get(edit.id);
    const field = () => live ? edit.key === "status" ? row?.status : row?.fields[edit.key] :
      replica.beats.get(edit.id)?.get(edit.key);
    const actual = edit.facet === "field" ? field() : live ? view.visual.get(edit.id) : readVisual(edit.id);
    return { ...edit, live, matches: edit.facet === "field" ? actual === edit.value :
      typeof actual === "string" && actual.includes(edit.value) };
  });
}
