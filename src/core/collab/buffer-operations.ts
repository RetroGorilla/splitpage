import type { BufferedCommit } from "./buffer.ts";
import type { SharedContentRef, SharedOperation, SharedTextAddress } from "./operations.ts";
import { FlowOperationTrace } from "../flow/operations.ts";
import { explode, implode } from "../text/edits.ts";
import { OBJ } from "../text/runs.ts";
import type { Run } from "../text/runs.ts";

export function bufferedTextOperations(
  commit: BufferedCommit,
  painted: { readonly revision: number; readonly text: string; readonly identity: (index: number) => SharedContentRef | null; readonly emptyGap?: SharedContentRef; readonly endGap?: SharedContentRef },
  target: SharedTextAddress,
  runs: readonly Run[],
  author: { readonly id: string; readonly by: string }
): readonly SharedOperation[] {
  const units = explode(runs), value = units.map(unit => unit.atom ? OBJ : unit.ch).join("");
  if (commit.base !== painted.revision || commit.text !== value) throw new Error("Buffered text does not match its native evidence");
  const cutsPair = (offset: number): boolean => value.charCodeAt(offset - 1) >= 0xd800 && value.charCodeAt(offset - 1) <= 0xdbff
    && value.charCodeAt(offset) >= 0xdc00 && value.charCodeAt(offset) <= 0xdfff;
  const identity = (index: number): SharedContentRef => {
    const found = painted.identity(index);
    if (!found) throw new Error("Missing painted identity");
    return found;
  };
  const operations: SharedOperation[] = [];
  let delta = 0;
  for (const [index, splice] of commit.splices.entries()) {
    const at = splice.from + delta;
    if (splice.insert.length) {
      const from = at - Number(cutsPair(at)), end = at + splice.insert.length, to = end + Number(cutsPair(end));
      const piece = implode(units.slice(from, to));
      const trace = new FlowOperationTrace({ rows: [] }, { cells: () => [] }, { id: author.id + ":" + index, by: author.by });
      trace.insert(target.owner, [], 0, piece);
      const insertion = trace.ops[0];
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
