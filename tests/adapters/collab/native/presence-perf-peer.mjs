import { performance } from "node:perf_hooks";
import { clearInterval, setInterval } from "node:timers";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { readNativeOnce } from "../../../../src/adapters/collab/native/reader.ts";
import { declareNativeRoots } from "../../../../src/adapters/collab/native/roots.ts";

export function openMovingPresencePeer(url) {
  const provider = new HocuspocusProvider({ url, name: "presence", token: "presence-test" });
  const beats = ["r3", "r150", "r299", "r2"];
  let moves = 0;
  let movesNearEdits = 0;
  let lastEdit = -Infinity;
  provider.document.on("update", () => { lastEdit = performance.now(); });
  const movement = setInterval(() => {
    if (performance.now() - lastEdit < 200) movesNearEdits++;
    provider.setAwarenessField("splitpagePresence", {
      name: "Moving Editor", color: "#EF958E", view: "split",
      beat: beats[moves++ % beats.length], side: "visualText"
    });
  }, 320);
  return {
    counts: () => ({ moves, movesNearEdits }),
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
