import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";

function caretNear(document, beat, moves) {
  try {
    return readNativeOnce(declareNativeRoots(document), reader => {
      const length = reader.row(beat)?.audioText.length;
      if (length === undefined) return null;
      const at = reader.narrationPaint(beat, false);
      const point = (offset, assoc) => {
        const { type, item } = Y.relativePositionToJSON(at(offset, assoc));
        return { type, item: item ?? null, assoc };
      };
      const head = Math.max(0, length - (moves % 3));
      const anchor = moves % 2 ? Math.max(0, head - 4) : head;
      return { anchor: point(anchor, 0), head: point(head, anchor === head ? 0 : -1) };
    });
  } catch {
    return null;
  }
}

export function openMovingPresencePeer(url) {
  const provider = new HocuspocusProvider({ url, name: "presence", token: "presence-test" });
  const beats = ["r1", "r150", "r2", "r299"];
  let moves = 0;
  let carets = 0;
  let movesNearEdits = 0;
  let lastEdit = -Infinity;
  provider.document.on("update", () => { lastEdit = performance.now(); });
  const movement = setInterval(() => {
    if (performance.now() - lastEdit < 200) movesNearEdits++;
    const beat = beats[moves % beats.length];
    const caret = caretNear(provider.document, beat, moves++);
    if (caret) carets++;
    provider.setAwarenessField("splitpagePresence", {
      name: "Moving Editor", color: "#EF958E", view: "split", beat, side: "audioText", caret
    });
  }, 320);
  return {
    counts: () => ({ moves, movesNearEdits, carets }),
    received(text) {
      return readNativeOnce(declareNativeRoots(provider.document), reader =>
        ["r1", "r2"].every(id => reader.row(id)?.audioText.includes(text)));
    },
    close() {
      clearInterval(movement);
      provider.destroy();
      provider.document.destroy();
    }
  };
}
