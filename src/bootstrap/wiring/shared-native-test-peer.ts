import { applyNativePeerUpdate } from "../../adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { sanitizeHtml } from "../richtext.ts";
import type { NativeFieldTarget } from "../../adapters/collab/native/record-commands.ts";
import type { NativeRegistryChange } from "../../adapters/collab/native/registry-commands.ts";
import type { NativeMarkChange } from "../../adapters/collab/native/format-commands.ts";
import type { NativeTextTarget } from "../../adapters/collab/native/text-commands.ts";
import type { NativeMoveBlock } from "../../adapters/collab/native/move-commands.ts";

type Packet = { to: "app" | "peer"; bytes: Uint8Array };
type ReplayOrder = "forward" | "reverse" | "duplicate";

export function createNativeTestPeer(app: ReturnType<typeof openNativeSession>, {
  peer = openNativeSession({ kind: "state", state: app.encodeState() }, { actor: "Peer", sanitize: sanitizeHtml }),
  applyUpdate = applyNativePeerUpdate
} = {}) {
  let paused = false;
  let capturing = false;
  let reader: ReturnType<typeof openNativeSession> | null = null;
  const packets: Packet[] = [];
  const replica = (source: "app" | "peer") => source === "app" ? app : peer;
  const openReader = (source: "app" | "peer") =>
    openNativeSession({ kind: "state", state: replica(source).encodeState() }, { actor: "Reader", sanitize: sanitizeHtml });
  const capture = (to: Packet["to"]) => (bytes: Uint8Array) => {
    if (capturing) packets.push({ to, bytes });
  };
  const stopAppUpdates = app.subscribeLocalUpdates(capture("peer"));
  const stopPeerUpdates = peer.subscribeLocalUpdates(capture("app"));
  const stop = app.subscribe(event => {
    if (event.kind === "changed" && !paused) applyUpdate(peer, app.encodeState());
  });
  function forward<Result extends { readonly kind: string }>(result: Result): Result {
    if (result.kind === "written" && !paused) applyUpdate(app, peer.encodeState());
    return result;
  }
  function edit(beat: string, from: number, to: number, text?: string) {
    if (!app.acceptsPeerUpdate()) return { kind: "refused", reason: "closed" } as const;
    const anchored = peer.commands.anchorText({ beat, cell: "narration" }, from, to);
    if (anchored.kind !== "anchored") return anchored;
    const result = text === undefined ? peer.commands.deleteText(anchored.range) : peer.commands.typeText(anchored.range, text, {});
    return forward(result);
  }
  function drain(order: ReplayOrder, to?: Packet["to"]) {
    const queued = packets.splice(0);
    const selected = queued.filter(packet => !to || packet.to === to);
    if (to) packets.push(...queued.filter(packet => packet.to !== to));
    const replay = order === "reverse" ? selected.reverse()
      : order === "duplicate" ? selected.flatMap(packet => [packet, packet]) : selected;
    const applied = [];
    for (const { to, bytes } of replay) {
      if (applyUpdate(to === "app" ? app : peer, bytes)) {
        applied.push({ to, bytes: Array.from(bytes) });
      }
    }
    return applied;
  }
  return {
    read: peer.document,
    seedReader: () => {
      reader ??= openReader("app");
      return reader.document();
    },
    readLateReader: () => reader?.document() ?? null,
    deliverToReader: (source: "app" | "peer") =>
      reader !== null && applyUpdate(reader, replica(source).encodeState()),
    freshSnapshot: (source: "app" | "peer") => {
      const fresh = openReader(source);
      try {
        return fresh.document();
      } finally {
        fresh.close();
      }
    },
    hold: (mode?: "updates") => {
      paused = true;
      capturing = mode === "updates";
      packets.length = 0;
    },
    queuedUpdates: () => packets.map(({ to, bytes }) => ({ to, bytes: Array.from(bytes) })),
    drain,
    release: (order: ReplayOrder) => {
      capturing = false;
      try {
        return drain(order);
      } finally {
        paused = false;
      }
    },
    deliver: () => {
      capturing = false;
      packets.length = 0;
      paused = false;
      const bytes = app.encodeState();
      applyUpdate(app, peer.encodeState());
      applyUpdate(peer, bytes);
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
    replaceAll: (...args: Parameters<typeof peer.commands.replaceAll>) => forward(peer.commands.replaceAll(...args)),
    undoPeer: () => forward(peer.commands.undo()),
    moveBeat: (id: string, drop: NativeMoveBlock | null) => forward(peer.commands.moveBlocks([{ kind: "beat", id }], drop)),
    removeComment: (id: string) => forward(peer.commands.removeComment({ comment: id })),
    step: (direction: "undo" | "redo") => app.commands[direction](),
    type: (beat: string, offset: number, text: string) => edit(beat, offset, offset, text),
    delete: (beat: string, from: number, to: number) => edit(beat, from, to),
    dispose: () => {
      stop();
      stopAppUpdates();
      stopPeerUpdates();
      packets.length = 0;
      reader?.close();
      reader = null;
      peer.close();
    }
  };
}
