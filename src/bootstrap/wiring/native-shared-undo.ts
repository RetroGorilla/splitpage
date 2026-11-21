import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { NativeUndoSelection } from "../../adapters/collab/native/text-commands.ts";
import type { SharedUndoOutcome } from "../../application/editing/undo/shared-undo.ts";
import type { UndoDirection } from "../../application/editing/undo/undo.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import { timingMarks } from "../../../shared/timing-marks.ts";
import type { SharedUndoRoute } from "./undo.ts";

export interface NativeUndoInput {
  readonly beforePress: () => string | null;
  readonly show: (selection: NativeUndoSelection) => void;
  readonly endGroup: () => void;
}

export interface NativeUndoRoutePorts {
  readonly native: Pick<ReturnType<typeof openNativeSession>, "commands" | "endTypingGroup">;
  readonly admission: Pick<SharedDocumentSession, "admit">;
  readonly input: () => NativeUndoInput | null;
  readonly publish: () => void;
}

interface NativePress {
  readonly outcome: SharedUndoOutcome;
  readonly selection?: NativeUndoSelection;
}

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

const NOTHING: SharedUndoOutcome = Object.freeze({ ok: false, empty: true });

function marking(): boolean {
  return (typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn;
}

export function nativeUndoRoute({ native, admission, input, publish }: NativeUndoRoutePorts): SharedUndoRoute {
  function press(direction: UndoDirection): NativePress {
    const refused = admission.admit();
    if (refused?.kind === "failed") throw refused.error;
    if (refused) return { outcome: { ok: false, reason: refused.reason } };
    const unsent = input()?.beforePress() ?? null;
    if (unsent) return { outcome: { ok: false, reason: unsent } };
    const result = native.commands[direction]();
    if (result.kind === "refused") return { outcome: { ok: false, reason: result.reason } };
    if (result.kind === "unchanged") return { outcome: NOTHING };
    publish();
    const outcome: SharedUndoOutcome = { ok: true, effective: true, label: direction, selection: null };
    return result.selection ? { outcome, selection: result.selection } : { outcome };
  }
  return Object.freeze({
    actions: Object.freeze({ undo: () => press("undo").outcome, redo: () => press("redo").outcome }),
    breakGroup: () => {
      const typing = input();
      if (typing) typing.endGroup();
      else native.endTypingGroup();
    },
    replayed: () => null,
    replay: (direction: UndoDirection) => {
      if (marking()) performance.mark("measure:input-command:start");
      try {
        const { selection } = press(direction);
        if (selection) input()?.show(selection);
      } finally { if (marking()) performance.mark("measure:input-command:end"); }
    }
  });
}
