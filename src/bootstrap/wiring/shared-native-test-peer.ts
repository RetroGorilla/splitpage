import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { sanitizeHtml } from "../richtext.ts";

export function createNativeTestPeer(app: ReturnType<typeof openNativeSession>) {
  const peer = openNativeSession({ kind: "state", state: app.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  const stop = app.subscribe(event => {
    if (event.kind === "changed") applyNativePeerUpdate(peer, app.encodeState());
  });
  function edit(beat: string, from: number, to: number, text?: string) {
    if (!app.acceptsPeerUpdate()) return { kind: "refused", reason: "closed" } as const;
    const anchored = peer.commands.anchorText({ beat, cell: "narration" }, from, to);
    if (anchored.kind !== "anchored") return anchored;
    const result = text === undefined ? peer.commands.deleteText(anchored.range) : peer.commands.typeText(anchored.range, text, {});
    if (result.kind === "written") applyNativePeerUpdate(app, peer.encodeState());
    return result;
  }
  return {
    read: peer.document,
    type: (beat: string, offset: number, text: string) => edit(beat, offset, offset, text),
    delete: (beat: string, from: number, to: number) => edit(beat, from, to),
    dispose: () => { stop(); peer.close(); }
  };
}
