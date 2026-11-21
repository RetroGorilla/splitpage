import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { sanitizeHtml } from "../richtext.ts";
import type { NativeFieldTarget } from "../../adapters/collab/native/record-commands.ts";
import type { NativeRegistryChange } from "../../adapters/collab/native/registry-commands.ts";
import type { NativeMarkChange } from "../../adapters/collab/native/format-commands.ts";
import type { NativeTextTarget } from "../../adapters/collab/native/text-commands.ts";
import type { NativeMoveBlock } from "../../adapters/collab/native/move-commands.ts";

type Packet = { to: "app" | "peer"; bytes: Uint8Array };

export function createNativeTestPeer(app: ReturnType<typeof openNativeSession>) {
  const peer = openNativeSession({ kind: "state", state: app.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml });
  let paused = false;
  let capturing = false;
  const packets: Packet[] = [];
  const capture = (to: Packet["to"]) =>
    (bytes: Uint8Array, _origin: unknown, _doc: unknown, transaction: { readonly local: boolean }) => {
      if (capturing && transaction.local) packets.push({ to, bytes: bytes.slice() });
    };
  const fromApp = capture("peer");
  const fromPeer = capture("app");
  app.ydoc.on("update", fromApp);
  peer.ydoc.on("update", fromPeer);
  const stop = app.subscribe(event => {
    if (event.kind === "changed" && !paused) applyNativePeerUpdate(peer, app.encodeState());
  });
  function forward<Result extends { readonly kind: string }>(result: Result): Result {
    if (result.kind === "written" && !paused) applyNativePeerUpdate(app, peer.encodeState());
    return result;
  }
  function edit(beat: string, from: number, to: number, text?: string) {
    if (!app.acceptsPeerUpdate()) return { kind: "refused", reason: "closed" } as const;
    const anchored = peer.commands.anchorText({ beat, cell: "narration" }, from, to);
    if (anchored.kind !== "anchored") return anchored;
    const result = text === undefined ? peer.commands.deleteText(anchored.range) : peer.commands.typeText(anchored.range, text, {});
    return forward(result);
  }
  return {
    read: peer.document,
    hold: (mode?: "updates") => {
      paused = true;
      capturing = mode === "updates";
      packets.length = 0;
    },
    queuedUpdates: () => packets.map(({ to, bytes }) => ({ to, bytes: Array.from(bytes) })),
    release: (order: "reverse" | "duplicate") => {
      capturing = false;
      const queued = packets.splice(0);
      const replay = order === "reverse" ? queued.reverse() : queued.flatMap(packet => [packet, packet]);
      const applied = [];
      try {
        for (const { to, bytes } of replay) {
          if (applyNativePeerUpdate(to === "app" ? app : peer, bytes)) {
            applied.push({ to, bytes: Array.from(bytes) });
          }
        }
        return applied;
      } finally {
        paused = false;
      }
    },
    deliver: () => {
      capturing = false;
      packets.length = 0;
      paused = false;
      const bytes = app.encodeState();
      applyNativePeerUpdate(app, peer.encodeState());
      applyNativePeerUpdate(peer, bytes);
    },
    field: (target: NativeFieldTarget, value: unknown) => forward(peer.commands.setField(target, value)),
    registry: (change: NativeRegistryChange) => forward(peer.commands.changeRegistry(change)),
    format: (target: NativeTextTarget, from: number, to: number, change: NativeMarkChange) => {
      const anchored = peer.commands.anchorText(target, from, to);
      return anchored.kind === "anchored" ? forward(peer.commands.formatText(anchored.range, change)) : anchored;
    },
    join: (lower: string, upper: string) => forward(peer.commands.joinRow(lower, upper, " ")),
    unjoin: (lower: string) => forward(peer.commands.unjoinRow(lower)),
    split: (beat: string, offset: number) => {
      const at = peer.commands.anchorText({ beat, cell: "narration" }, offset);
      return at.kind === "anchored" ? forward(peer.commands.splitRow(at.range)) : at;
    },
    removeBeat: (id: string) => forward(peer.commands.removeRows([id])),
    moveBeat: (id: string, drop: NativeMoveBlock | null) => forward(peer.commands.moveBlocks([{ kind: "beat", id }], drop)),
    removeComment: (id: string) => forward(peer.commands.removeComment({ comment: id })),
    step: (direction: "undo" | "redo") => app.commands[direction](),
    type: (beat: string, offset: number, text: string) => edit(beat, offset, offset, text),
    delete: (beat: string, from: number, to: number) => edit(beat, from, to),
    dispose: () => {
      stop();
      app.ydoc.off("update", fromApp);
      peer.ydoc.off("update", fromPeer);
      packets.length = 0;
      peer.close();
    }
  };
}
