import type { KeptCommand, KeptStep, ReplayResult } from "./replay.ts";
import { need } from "../native-delete/model.ts";

interface RecordedEdit {
  index: number;
  by: number;
  cmd: KeptCommand;
  seen: Set<number>;
}

function commands(steps: readonly KeptStep[]): RecordedEdit[] {
  const known = [new Set<number>(), new Set<number>(), new Set<number>()], edits: RecordedEdit[] = [];
  for (const [index, step] of steps.entries()) {
    if ("by" in step) {
      const seen = need(known[step.by], "writer");
      edits.push({ index, by: step.by, cmd: step.cmd, seen: new Set(seen) });
      seen.add(index);
    } else if ("open" in step) known[step.open] = new Set(need(known[step.from], "source"));
    else for (const id of need(known[step.from], "source")) need(known[step.to], "destination").add(id);
  }
  return edits;
}

export function auditCrossings(steps: readonly KeptStep[], built: ReplayResult, kept: ReplayResult, counts: Record<string, number>): void {
  const edits = commands(steps);
  const tally = (key: string): void => { counts[key] = (counts[key] ?? 0) + 1; };
  for (const edit of edits) {
    const { cmd } = edit;
    if (cmd.op !== "field" && (cmd.op !== "type" || cmd.field !== "visual")) continue;
    if (!/^[A-F]$/.test(cmd.id)) continue;
    const cuts = edits.filter(other => kept.cuts.get(other.index)?.has(cmd.id) || built.cuts.get(other.index)?.has(cmd.id));
    if (cuts.length !== 1) continue;
    const cut = need(cuts[0], "single deletion");
    if (cut.by === edit.by || cut.seen.has(edit.index) || edit.seen.has(cut.index)) continue;
    if (!built.cuts.get(cut.index)?.has(cmd.id) || !kept.cuts.get(cut.index)?.has(cmd.id)) continue;
    const touched = edits.some(other => {
      if (other.index !== edit.index && "id" in other.cmd && other.cmd.id === cmd.id) {
        if (cmd.op === "field" && other.cmd.op === "field" && other.cmd.key === cmd.key) return true;
        if (cmd.op === "type" && other.cmd.op === "erase" && other.cmd.field === "visual") return true;
      }
      return other.index > edit.index && other.by === edit.by && (other.cmd.op === "undo" || other.cmd.op === "redo");
    });
    if (touched) continue;
    const live = !kept.orphans.includes(cmd.id) && !!kept.state?.beats[cmd.id];
    const builtLive = !!built.state?.beats[cmd.id] && !built.orphans.includes(cmd.id);
    if (live !== builtLive) continue;
    const restored = built.restored.has(cmd.id) && kept.restored.has(cmd.id);
    if (live ? !restored : built.restored.has(cmd.id) || kept.restored.has(cmd.id)) continue;
    const stored = (result: ReplayResult): boolean => cmd.op === "field" ? result.state?.beats[cmd.id]?.[cmd.key] === cmd.value
      : (result.state?.visuals[cmd.id]?.map(item => item.insert).join("") ?? "").includes(cmd.text);
    const kind = `${live ? "restored" : "never restored"} ${cmd.op === "field" ? "field" : "visual"}`;
    tally(`${kind} candidates`);
    if (stored(built)) tally(`${kind} built`);
    if (stored(kept)) tally(`${kind} kept`);
  }
}
