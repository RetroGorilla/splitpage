import assert from "node:assert/strict";
import { MarkTraceReplica, markTraceExample, markTraceKinds } from "./marks/replica.ts";
import type { MarkTraceCommand } from "./marks/replica.ts";
import { registerSharedTextOperationHandlers } from "../../../src/adapters/collab/text-executor.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { captureSharedTextRange } from "../../../src/adapters/collab/executor-references.ts";
import { createSharedAnchor } from "../../../src/adapters/collab/anchors.ts";
import { operation } from "./executor-support.ts";
import { typingMarks } from "../../../src/core/text/edits.ts";
import type { Marks } from "../../../src/core/text/runs.ts";

export class TextExecutorTraceReplica extends MarkTraceReplica {
  private readonly executed: (kind: string) => void;
  constructor(client: number, initial?: string, state?: Uint8Array, executed: (kind: string) => void = () => {}) {
    super(client, initial, state); this.executed = executed; registerSharedTextOperationHandlers(this.handle);
  }
  override execute(command: MarkTraceCommand): void {
    if (command.kind === "add" || command.kind === "remove") { super.execute(command); return; }
    const observed = captureSharedTextRange(this.handle, this.target, command.from, command.to); assert.ok(observed);
    const at = createSharedAnchor(this.handle, this.target, command.from, "after"); assert.ok(at);
    const runs = this.read().map(char => ({ text: char.value, marks: Object.fromEntries(char.marks.filter(mark => !("id" in mark)).map(mark => [mark.kind, true])) as Marks }));
    const marks = command.mode === "inherit" ? Object.keys(typingMarks(runs, command.from)).map(kind => markTraceExample(kind as "b"))
      : command.mode === "plain" ? markTraceKinds.map(kind => ({ ...markTraceExample(kind), value: null })) : command.marks ?? [];
    const op = command.kind === "delete" ? operation({ kind: "text-delete", id: command.id, by: "Writer", target: this.target, observed: [observed] })
      : operation({ kind: "text-insert", id: command.id, by: "Writer", target: this.target, at: { left: null, right: at, affinity: "before" }, content: [{ value: command.text ?? "", marks }] });
    assert.deepEqual(executeSharedOperations(this.handle, [op]), { ok: true }); this.executed(op.kind);
  }
}
