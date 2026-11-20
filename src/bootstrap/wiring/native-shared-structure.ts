import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeMoveBlock } from "../../adapters/collab/native/move-commands.ts";
import type { NativeUndoSelectionInput } from "../../adapters/collab/native/text-commands.ts";
import type { CommandOutcome, DocumentStructureIntent } from "../../application/session/document-session.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import { changesBetween } from "../../application/session/projection-changes.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { sceneBeforeBeat, sceneFirstBeatId } from "../../core/document/scenes.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { cappedText } from "../../core/document/text-policy.ts";
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

function moveDrop(doc: ValidatedDocument, source: string, target: string, after: boolean, insideScene: boolean): NativeMoveBlock | null {
  const rows = doc.rows.filter(row => row.id !== source);
  const at = rows.findIndex(row => row.id === target);
  const next = rows[at + (after ? 1 : 0)];
  if (!next) return null;
  const heading = insideScene && !after ? undefined : sceneBeforeBeat(doc, next.id);
  return heading ? { kind: "heading", id: heading.id } : { kind: "beat", id: next.id };
}

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
      let after: NativeUndoSelectionInput | null = current?.range ?? null, landing: string | undefined, restore = false;
      let step;
      switch (intent.kind) {
        case "remove-beat": {
          const at = before.rows.findIndex(row => row.id === intent.id);
          if (at < 0) return owner.refuse("missing");
          const selection = current?.range ?? anchor(intent.id, 0);
          step = native.commands.removeRows.withSelection(selection, [intent.id]);
          if (!current || current.row === intent.id) {
            landing = (before.rows[at + 1] ?? before.rows[at - 1])?.id;
            after = landing ? anchor(landing, 0) : null;
          }
          break;
        }
        case "add-heading": {
          const name = cappedText(intent.name, 200), at = anchor(intent.beat, 0);
          if (!name || sceneBeforeBeat(before, intent.beat)) return { kind: "noop" };
          if (!at) return owner.refuse("missing");
          after ??= at;
          step = native.commands.createHeading.withSelection(after, at, intent.id, name);
          break;
        }
        case "rename-heading":
        case "remove-heading": {
          const scene = before.sections?.find(item => item.id === intent.id);
          if (!scene) return owner.refuse("missing");
          after ??= anchor(sceneFirstBeatId(scene), 0);
          if (intent.kind === "remove-heading") {
            step = native.commands.removeHeading.withSelection(after, intent.id);
          } else {
            const name = cappedText(intent.name, 200);
            if (!name) return { kind: "noop" };
            const range = native.commands.anchorText({ beat: intent.id, cell: "name" }, 0, scene.name.length);
            if (range.kind === "refused") return owner.refuse(range.reason);
            step = native.commands.renameHeading.withSelection(after, range.range, name);
          }
          break;
        }
        case "move-beat":
        case "swap-beats": {
          const at = before.rows.findIndex(row => row.id === intent.id);
          if (at < 0) return owner.refuse("missing");
          const target = intent.kind === "move-beat" ? intent.target : before.rows[at + intent.direction]?.id;
          if (!target || target === intent.id) return { kind: "noop" };
          if (!before.rows.some(row => row.id === target)) return owner.refuse("missing");
          const afterTarget = intent.kind === "move-beat" ? intent.after : intent.direction > 0;
          const drop = moveDrop(before, intent.id, target, afterTarget, intent.kind === "move-beat" && !!intent.intoScene);
          after ??= anchor(intent.id, 0);
          step = native.commands.moveBlocks.withSelection(after, [{ kind: "beat", id: intent.id }], drop);
          restore = true;
          break;
        }
      }
      if (step.result.kind === "refused") return owner.refuse(step.result.reason);
      if (step.result.kind === "unchanged") return { kind: "noop" };
      step.recordAfter(after);
      const changes = changesBetween(before, native.document());
      publish();
      if (landing) {
        const point = { target: { beat: landing, cell: "narration" as const }, offset: 0 };
        typing.show({ anchor: point, head: point });
      } else if (restore && current) {
        typing.show({ anchor: current.point, head: current.point });
      }
      return { kind: "applied", generation: owner.generation(), changes };
    } catch (error) {
      report(error);
      return owner.refuse(UNAVAILABLE);
    }
  };
}
