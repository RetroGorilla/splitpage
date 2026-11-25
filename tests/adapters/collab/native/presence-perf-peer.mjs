import { HocuspocusProvider } from "@hocuspocus/provider";

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
    close() {
      clearInterval(movement);
      provider.destroy();
      provider.document.destroy();
    }
  };
}
