import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { sanitizeHtml } from "../richtext.ts";

export function createNativeTestPeer(app: ReturnType<typeof openNativeSession>) {
  const peer = openNativeSession({ kind: "state", state: app.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  const stop = app.subscribe(event => {
    if (event.kind === "changed") applyNativePeerUpdate(peer, app.encodeState());
  });
  return {
    read: peer.document,
    type: (beat: string, offset: number, text: string) => {
      const anchored = peer.commands.anchorText({ beat, cell: "narration" }, offset);
      if (anchored.kind !== "anchored") return anchored;
      const result = peer.commands.typeText(anchored.range, text, {});
      if (result.kind === "written") applyNativePeerUpdate(app, peer.encodeState());
      return result;
    },
    dispose: () => { stop(); peer.close(); }
  };
}
