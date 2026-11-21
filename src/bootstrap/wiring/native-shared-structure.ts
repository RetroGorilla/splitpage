import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeMoveBlock } from "../../adapters/collab/native/move-commands.ts";
import type { NativeUndoSelectionInput } from "../../adapters/collab/native/text-commands.ts";
import type { CommandOutcome, DocumentStructureIntent } from "../../application/session/document-session.ts";
import type { ReportPort } from "../../application/session/ports.ts";
import { changesBetween } from "../../application/session/projection-changes.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { sceneBeforeBeat, sceneFirstBeatId, sceneForBeat, scenesInOrder, storedSceneName } from "../../core/document/scenes.ts";
import type { SceneDocument } from "../../core/document/scenes.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import { documentReader } from "./ports/document.ts";
import { editAllowed, sessionStamps } from "./session-owner.ts";
import type { mountNativeSharedInput } from "./native-shared-input.ts";

interface NativeStructurePorts {
  readonly native: ReturnType<typeof openNativeSession>;
  readonly session: () => SharedDocumentSession | null;
  readonly input: () => ReturnType<typeof mountNativeSharedInput> | null;
  readonly publish: () => void;
  readonly report: ReportPort;
}

const UNAVAILABLE = "native-command-unavailable";

type MoveIntent = Extract<DocumentStructureIntent, { kind: "move-beat" | "swap-beats" }>;
function insertPlacement(doc: SceneDocument, id: string, side: "above" | "below") {
  const at = doc.rows.findIndex(row => row.id === id);
  if (at < 0) return null;
  const scene = sceneForBeat(doc, id)?.id ?? null;
  const next = doc.rows[at + (side === "above" ? -1 : 1)]?.id;
  const heading = side === "above" ? sceneBeforeBeat(doc, id) : next ? sceneBeforeBeat(doc, next) : undefined;
  return { scene, neighbour: heading?.id ?? next ?? null, kind: heading ? "heading" : "beat" };
}

export function sameNativeInsertPlacement(shown: SceneDocument | null, live: SceneDocument, beat: string, side: "above" | "below"): boolean {
  const before = shown && insertPlacement(shown, beat, side), after = insertPlacement(live, beat, side);
  return !!before && !!after && before.scene === after.scene && before.neighbour === after.neighbour && before.kind === after.kind;
}

function movePlacement(doc: SceneDocument, intent: MoveIntent) {
  const source = doc.rows.findIndex(row => row.id === intent.id);
  if (source < 0) return null;
  const target = intent.kind === "move-beat" ? intent.target : doc.rows[source + intent.direction]?.id;
  if (!target || target === intent.id) return { target: null, previous: null, drop: null };
  const rows = doc.rows.filter(row => row.id !== intent.id);
  const at = rows.findIndex(row => row.id === target);
  if (at < 0) return null;
  const after = intent.kind === "move-beat" ? intent.after : intent.direction > 0;
  const index = at + (after ? 1 : 0), next = rows[index];
  const heading = next && !(intent.kind === "move-beat" && intent.intoScene && !after) ? sceneBeforeBeat(doc, next.id) : undefined;
  const drop: NativeMoveBlock | null = heading ? { kind: "heading", id: heading.id } : next ? { kind: "beat", id: next.id } : null;
  return { target, previous: rows[index - 1]?.id ?? null, drop };
}

export function createNativeEditorStructure({ native, session, input, publish, report }: NativeStructurePorts) {
  function anchor(beat: string, offset: number, cell: "narration" | "visual" = "narration") {
    const result = native.commands.anchorText({ beat, cell }, offset);
    return result.kind === "anchored" ? result.range : null;
  }

  return (intent: DocumentStructureIntent): CommandOutcome => {
    const owner = session(), typing = input();
    if (!owner || !typing) return { kind: "rejected", reason: "closed" };
    try {
      const moving = intent.kind === "move-beat" || intent.kind === "swap-beats";
      const inserting = intent.kind === "insert-beat";
      const shown = moving ? documentReader.read(doc => doc && movePlacement(doc, intent)) : null;
      const shownInsert = inserting ? documentReader.current() : null;
      const menu = inserting && !intent.focus ? typing.takeInsertMenuSelection() : null;
      const captured = moving || inserting ? menu?.narration ?? typing.captureMoveSelection() : null;
      const admission = owner.admit();
      if (admission?.kind === "failed") throw admission.error;
      if (admission) return admission.notified ? admission : owner.refuse(admission.reason);
      if (!editAllowed()) return owner.refuse(UNAVAILABLE);
      const movedSelection = captured ? typing.settleMoveSelection(captured) : null;
      const pending = movedSelection ? movedSelection.kind === "refused" && movedSelection.reason : typing.beforePress();
      if (pending) return { kind: "rejected", reason: pending, notified: true };
      const before = native.document();
      const current = moving ? null : typing.currentCaret();
      let after: NativeUndoSelectionInput | null = (movedSelection?.kind === "ready" ? movedSelection.range : current?.range) ?? null;
      let landing: string | undefined;
      let step;
      switch (intent.kind) {
        case "insert-beat": {
          if (!sameNativeInsertPlacement(shownInsert, before, intent.id, "below")) return owner.refuse(UNAVAILABLE);
          const selection = menu?.visual ?? (intent.focus === "visual" ? typing.visualSelection(intent.id) : after);
          after = selection ?? anchor(intent.id, 0, intent.focus);
          step = native.commands.insertAdjacentBeat.withSelection(after, intent.id, "below",
            { by: sessionStamps.editor.name(), at: sessionStamps.clock.nowIso() });
          if (step.result.kind === "written" && intent.focus) {
            landing = step.result.created;
            after = anchor(landing, 0, intent.focus);
          }
          break;
        }
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
          const scene = scenesInOrder(before)?.find(item => item.id === intent.id);
          if (!scene) return owner.refuse("missing");
          after ??= anchor(sceneFirstBeatId(scene), 0);
          if (intent.kind === "remove-heading") {
            step = native.commands.removeHeading.withSelection(after, intent.id);
          } else {
            const name = cappedText(intent.name, 200);
            if (!name) return { kind: "noop" };
            const length = (storedSceneName(before, intent.id) ?? scene.name).length;
            const range = native.commands.anchorText({ beat: intent.id, cell: "name" }, 0, length);
            if (range.kind === "refused") return owner.refuse(range.reason);
            step = native.commands.renameHeading.withSelection(after, range.range, name);
          }
          break;
        }
        case "move-beat":
        case "swap-beats": {
          const live = movePlacement(before, intent);
          if (!shown || !live || shown.target !== live.target) return owner.refuse(UNAVAILABLE);
          if (intent.kind === "move-beat" && (shown.previous !== live.previous
            || shown.drop?.kind !== live.drop?.kind || shown.drop?.id !== live.drop?.id)) return owner.refuse(UNAVAILABLE);
          if (!shown.target) return { kind: "noop" };
          after ??= anchor(intent.id, 0);
          step = native.commands.moveBlocks.withSelection(after, [{ kind: "beat", id: intent.id }], live.drop);
          break;
        }
      }
      if (step.result.kind === "refused") return owner.refuse(step.result.reason);
      if (step.result.kind === "unchanged") return { kind: "noop" };
      step.recordAfter(after);
      const changes = changesBetween(before, native.document());
      publish();
      if (landing) {
        const cell = intent.kind === "insert-beat" ? intent.focus ?? "narration" : "narration";
        const point = { target: { beat: landing, cell }, offset: 0 } as const;
        typing.show({ anchor: point, head: point });
      } else if (inserting && menu?.visual) {
        const anchor = native.resolveTextSelection(menu.visual.anchor)?.anchor;
        const head = native.resolveTextSelection(menu.visual.head)?.head;
        if (anchor && head) typing.show({ anchor, head });
      } else if (movedSelection?.kind === "ready") {
        typing.show(movedSelection.selection);
      }
      return { kind: "applied", generation: owner.generation(), changes };
    } catch (error) {
      report(error);
      return owner.refuse(UNAVAILABLE);
    }
  };
}
