import type { BufferedCommit } from "./buffer.ts";
import type { SharedContentRef, SharedOperation, SharedTextAddress } from "./operations.ts";
import { FlowOperationTrace } from "../flow/operations.ts";
import { sliceCell } from "../text/edits.ts";
import { projection } from "../text/runs.ts";
import type { Run } from "../text/runs.ts";

export function bufferedTextOperations(
  commit: BufferedCommit,
  painted: { readonly revision: number; readonly text: string; readonly identity: (index: number) => SharedContentRef | null; readonly emptyGap?: SharedContentRef; readonly endGap?: SharedContentRef },
  target: SharedTextAddress,
  runs: readonly Run[],
  author: { readonly id: string; readonly by: string }
): readonly SharedOperation[] {
  if (commit.base !== painted.revision || commit.text !== projection(runs)) throw new Error("Buffered text does not match its native evidence");
  const identity = (index: number): SharedContentRef => {
    const found = painted.identity(index);
    if (!found) throw new Error("Missing painted identity");
    return found;
  };
  const operations: SharedOperation[] = [];
  let delta = 0;
  for (const [index, splice] of commit.splices.entries()) {
    const at = splice.from + delta;
    const piece = sliceCell(runs, at, at + splice.insert.length);
    const trace = new FlowOperationTrace({ rows: [] }, { cells: () => [] }, { id: author.id + ":" + index, by: author.by });
    trace.insert(target.owner, [], 0, piece);
    const insertion = trace.ops[0];
    if (splice.insert.length) {
      if (insertion?.kind !== "text-insert") throw new Error("Missing buffered insertion");
      const right = splice.from < painted.text.length ? identity(splice.from) : painted.emptyGap ?? null;
      const left = right ? null : painted.endGap ?? null;
      if (!left && !right) throw new Error("Missing painted empty gap");
      operations.push({ ...insertion, target, at: { left, right, affinity: right ? "before" : "after" } });
    }
    if (splice.to > splice.from) operations.push({ kind: "text-delete", target,
      id: (author.id + ":" + index + ":delete") as SharedContentRef, by: author.by,
      observed: Array.from({ length: splice.to - splice.from }, (_, offset) => identity(splice.from + offset)) });
    delta += splice.insert.length - (splice.to - splice.from);
  }
  return operations;
}
