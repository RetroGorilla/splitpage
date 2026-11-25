import type { openNativeSession } from "../../adapters/collab/native/session.ts";
import type { PresenceCaret, PresenceLocation, PresencePeer } from "../../application/collaboration/presence.ts";
import { editorKeys, mapEndsThroughCell } from "../../core/text/selection.ts";
import type { CellEnds } from "../../core/text/selection.ts";
import { domKeys } from "../../features/common/cell-dom.ts";

type PresenceNative = Pick<ReturnType<typeof openNativeSession>, "presencePoint" | "presenceOffset" | "readRow" | "isClosingOrClosed">;
type Side = NonNullable<PresenceLocation["side"]>;

function sharedKeys(native: PresenceNative, row: string, side: Side): readonly string[] | null {
  const read = native.readRow(row);
  return read ? editorKeys(side === "audioText" ? read.narration : read.visual) : null;
}

export function createNativePresenceCarets(native: PresenceNative) {
  return Object.freeze({
    caret(location: PresenceLocation, cell: Element, painted: CellEnds): PresenceCaret | null {
      const { beat, side } = location;
      if (!beat || !side || native.isClosingOrClosed()) return null;
      const keys = sharedKeys(native, beat, side);
      if (!keys) return null;
      const { anchor, head } = mapEndsThroughCell(painted, domKeys(cell), keys);
      if (anchor === head) {
        const at = native.presencePoint(beat, side, head, 0);
        return at && { anchor: at, head: at };
      }
      const start = native.presencePoint(beat, side, Math.min(anchor, head), 0);
      const end = native.presencePoint(beat, side, Math.max(anchor, head), -1);
      if (!start || !end) return null;
      return anchor < head ? { anchor: start, head: end } : { anchor: end, head: start };
    },
    resolve(peer: PresencePeer, cell: Element): CellEnds | null {
      const { caret, side } = peer;
      const row = cell.getAttribute("data-id");
      if (!caret || !side || !row || native.isClosingOrClosed()) return null;
      const anchor = native.presenceOffset(row, side, caret.anchor);
      const head = native.presenceOffset(row, side, caret.head);
      const keys = anchor === null || head === null ? null : sharedKeys(native, row, side);
      return keys && anchor !== null && head !== null ? mapEndsThroughCell({ anchor, head }, keys, domKeys(cell)) : null;
    }
  });
}
