import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeUndoSelectionInput } from "../../adapters/collab/native/text-commands.ts";
import type { CommandOutcome, DocumentStructureIntent } from "../../application/session/document-session.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import { changesBetween } from "../../application/session/projection-changes.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { editAllowed } from "./session-owner.ts";
import type { mountNativeSharedInput } from "./native-shared-input.ts";

interface NativeStructurePorts {
  readonly native: ReturnType<typeof openNativeSession>;
  readonly session: () => SharedDocumentSession | null;
  readonly input: () => ReturnType<typeof mountNativeSharedInput> | null;
  readonly publish: () => void;
  readonly report: ReportPort;
}

const UNAVAILABLE = "native-command-unavailable";

export function createNativeEditorStructure({ native, session, input, publish, report }: NativeStructurePorts) {
  function anchor(beat: string, offset: number) {
    const result = native.commands.anchorText({ beat, cell: "narration" }, offset);
    return result.kind === "anchored" ? result.range : null;
  }

  return (intent: DocumentStructureIntent): CommandOutcome => {
    const owner = session(), typing = input();
    if (!owner || !typing) return { kind: "rejected", reason: "closed" };
    try {
      const admission = owner.admit();
      if (admission?.kind === "failed") throw admission.error;
      if (admission) return admission.notified ? admission : owner.refuse(admission.reason);
      if (!editAllowed()) return owner.refuse(UNAVAILABLE);
      const pending = typing.beforePress();
      if (pending) return { kind: "rejected", reason: pending, notified: true };
      const before = native.document();
      const current = typing.currentCaret();
      let after: NativeUndoSelectionInput | null = current?.range ?? null;
      let land: (() => void) | undefined;
      const at = before.rows.findIndex(row => row.id === intent.id);
      const selection = current?.range ?? anchor(intent.id, 0);
      const step = native.commands.removeRows.withSelection(selection, [intent.id]);
      if (!current || current.row === intent.id) {
        const row = before.rows[at + 1] ?? before.rows[at - 1];
        after = row ? anchor(row.id, 0) : null;
        if (row) {
          const point = { target: { beat: row.id, cell: "narration" as const }, offset: 0 };
          land = () => typing.show({ anchor: point, head: point });
        }
      }
      if (step.result.kind === "refused") return owner.refuse(step.result.reason);
      if (step.result.kind === "unchanged") return { kind: "noop" };
      step.recordAfter(after);
      const changes = changesBetween(before, native.document());
      publish();
      land?.();
      return { kind: "applied", generation: owner.generation(), changes };
    } catch (error) {
      report(error);
      return owner.refuse(UNAVAILABLE);
    }
  };
}
