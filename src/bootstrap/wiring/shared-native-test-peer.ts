import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { sanitizeHtml } from "../richtext.ts";
import type { NativeFieldTarget } from "../../adapters/collab/native/record-commands.ts";

export function createNativeTestPeer(app: ReturnType<typeof openNativeSession>) {
  const peer = openNativeSession({ kind: "state", state: app.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  let paused = false;
  const stop = app.subscribe(event => {
    if (event.kind === "changed" && !paused) applyNativePeerUpdate(peer, app.encodeState());
  });
  function forward<Result extends { readonly kind: string }>(result: Result): Result {
    if (result.kind === "written" && !paused) applyNativePeerUpdate(app, peer.encodeState());
    return result;
  }
  return {
    read: peer.document,
    hold: () => { paused = true; },
    deliver: () => {
      paused = false;
      const bytes = app.encodeState();
      applyNativePeerUpdate(app, peer.encodeState());
      applyNativePeerUpdate(peer, bytes);
    },
    field: (target: NativeFieldTarget, value: unknown) => forward(peer.commands.setField(target, value)),
    join: (lower: string, upper: string) => forward(peer.commands.joinRow(lower, upper, " ")),
    removeBeat: (id: string) => forward(peer.commands.removeRows([id])),
    removeComment: (id: string) => forward(peer.commands.removeComment({ comment: id })),
    step: (direction: "undo" | "redo") => app.commands[direction](),
    type: (beat: string, offset: number, text: string) => {
      if (!app.acceptsPeerUpdate()) return { kind: "refused", reason: "closed" } as const;
      const anchored = peer.commands.anchorText({ beat, cell: "narration" }, offset);
      if (anchored.kind !== "anchored") return anchored;
      return forward(peer.commands.typeText(anchored.range, text, {}));
    },
    dispose: () => { stop(); peer.close(); }
  };
}
