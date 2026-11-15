import { applySharedUpdate, createSharedDocument, destroySharedDocument, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate,
  observeSharedUpdates, shouldDeliverSharedUpdate } from "../../adapters/collab/document.ts";
import { observeSharedDeclined } from "../../adapters/collab/ingress.ts";
import { registerSharedOperationFamilies } from "../../adapters/collab/operation-families.ts";
import { createSharedReplica } from "../../adapters/collab/replica.ts";
import { createSharedSession } from "../../application/session/shared-session.ts";
import { createSessionCapabilities } from "../../application/session/capabilities.ts";
import { enterSharedDocument } from "../../core/migrate.ts";
import type { SharedSwitchPorts, SharedSessionParts } from "./shared-session.ts";
import { sharedAuthorPort } from "./ports/shared-author.ts";
import { sharedBufferPorts } from "./ports/shared-buffer.ts";
import { sharedStructurePorts } from "./ports/shared-values.ts";
import { deleteBeatCommand } from "../../application/commands/rows.ts";
import { productionReaders } from "../document-ports.ts";
import { sessionStamps } from "./session-owner.ts";

export function createSharedTestPeer(app: SharedSessionParts, ports: SharedSwitchPorts) {
  const handle = createSharedDocument();
  registerSharedOperationFamilies(handle, ports.structure);
  const hydrated = applySharedUpdate(handle, encodeSharedState(app.handle));
  if (!hydrated.ok) { destroySharedDocument(handle); throw new Error(hydrated.reason); }
  const replica = createSharedReplica(handle);
  const session = createSharedSession({ replica, entry: enterSharedDocument, undo: { record: () => {} },
    effects: { dirty: () => {}, draft: () => {}, save: () => {}, refresh: () => {} },
    capability: createSessionCapabilities("shared", ports.common), report: ports.report, timers: ports.timers, refused: ports.commandRefused });
  let live = true, paused = false;
  const author = sharedAuthorPort({ handle: () => live ? handle : null, name: () => "Peer" });
  const text = sharedBufferPorts(handle, session, { author: () => {
    const next = author.next(); if (!next) throw new Error("The peer has left"); return next;
  }, readers: productionReaders, stamps: { clock: sessionStamps.clock, editor: { name: () => "Peer" } },
  missingBase: () => {}, recovered: () => {}, report: ports.report });
  const structure = sharedStructurePorts({ handle: () => live ? handle : null, author: () => author.next(),
    stamps: { clock: sessionStamps.clock, editor: { name: () => "Peer" } }, cells: html => ports.structure.cells(html) });
  const pending: { readonly side: "app" | "peer"; readonly id: number; readonly update: Uint8Array }[] = [];
  const applied: { readonly to: "app" | "peer"; readonly update: number }[] = [];
  let sent = 0;
  const enqueue = (side: "app" | "peer", update: Uint8Array): void => {
    if (!live) return;
    pending.push({ side, id: ++sent, update: Uint8Array.from(update) });
    if (!paused) queueMicrotask(() => { if (live && !paused) deliver(); });
  };
  const receive = (side: "app" | "peer", update: Uint8Array, id?: number): void => {
    const result = applySharedUpdate(side === "app" ? app.handle : handle, update);
    if (!result.ok && result.reason !== "queue-full") throw new Error(result.reason);
    if (result.ok && id !== undefined) applied.push({ to: side, update: id });
  };
  const resend = (side: "app" | "peer"): void => {
    if (!live) return;
    const target = side === "app" ? app.handle : handle, source = side === "app" ? handle : app.handle;
    receive(side, encodeSharedUpdate(source, encodeSharedStateVector(target)));
  };
  function deliver(order: "forward" | "reverse" | "duplicate" = "forward"): number {
    if (!live) throw new Error("The peer has left");
    const updates = pending.splice(0);
    if (order === "reverse") updates.reverse();
    for (const item of updates) {
      receive(item.side, item.update, item.id);
      if (order === "duplicate") receive(item.side, item.update, item.id);
    }
    return updates.length;
  }
  const releases = [
    observeSharedUpdates(app.handle, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) enqueue("peer", update); }),
    observeSharedUpdates(handle, (update, origin) => { if (shouldDeliverSharedUpdate(origin)) enqueue("app", update); }),
    observeSharedDeclined(app.handle, () => { resend("app"); }), observeSharedDeclined(handle, () => { resend("peer"); })
  ];
  return {
    type: (rowId: string, offset: number, insert: string) => {
      if (!live) throw new Error("The peer has left");
      const base = text.paintedText.read(rowId, "audioText");
      if (!base) throw new Error("The peer beat is missing");
      const edit = text.bufferedText.open(rowId, base);
      if (!edit) throw new Error("The peer buffer is unavailable");
      edit.replace(offset, offset, insert);
      try { return edit.commit([{ text: edit.text(), marks: {} }], [offset + insert.length, offset + insert.length]); }
      finally { if (edit.isOpen()) edit.cancel(); }
    },
    remove: (rowId: string) => {
      if (!live) throw new Error("The peer has left");
      return session.run(deleteBeatCommand(rowId, structure() ?? undefined)).kind;
    },
    deliver,
    hold: () => { paused = true; },
    release: (order: "forward" | "reverse" | "duplicate" = "forward") => { paused = false; return deliver(order); },
    read: () => session.read(doc => doc ? JSON.parse(JSON.stringify(doc)) as unknown : null),
    queued: () => pending.length,
    appliedUpdates: () => applied.map(entry => ({ ...entry })),
    dispose: () => {
      live = false;
      for (const release of releases) release();
      pending.length = 0; session.dispose(); replica.dispose(); destroySharedDocument(handle);
    }
  };
}
