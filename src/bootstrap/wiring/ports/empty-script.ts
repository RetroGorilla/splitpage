import { emptyScriptCommand } from "../../../application/commands/empty-script.ts";
import type { CommonDocumentSession } from "../../../application/session/document-session.ts";
import type { StampPorts } from "../../../application/session/ports.ts";
import type { SharedDocumentHandle } from "../../../adapters/collab/types.ts";
import type { EmptyScriptPorts } from "../../../features/empty-script/ports.ts";
import { startEmptyScript } from "../../../features/empty-script/empty-script.ts";
import { holdSharedBuffer } from "../../../adapters/collab/ingress.ts";
import { observeSharedStructureOrder } from "../../../adapters/collab/structure-order-index.ts";
import { sharedStructureIdentity } from "../../../adapters/collab/structure-identity.ts";
import { collabState } from "../../../adapters/collab/state.ts";
import { readSharedContentRef } from "../../../core/collab/read-operation.ts";
import type { SharedAuthorPort } from "./shared-author.ts";

export function mountSharedEmptyScript(shared: {
  readonly handle: SharedDocumentHandle;
  readonly session: Pick<CommonDocumentSession, "read" | "run" | "epoch" | "subscribe" | "beforeCommand">;
  readonly author: SharedAuthorPort;
  readonly writer: () => string;
  readonly stamps: StampPorts;
}, surface: Pick<EmptyScriptPorts, "host" | "edits" | "notices" | "place">) {
  const order = observeSharedStructureOrder(shared.handle);
  return startEmptyScript({ ...surface, lifetime: shared.session,
    document: { current: () => shared.session.read(doc => doc), onChange: shared.session.subscribe },
    hold: () => {
      if (collabState(shared.handle).ingress.holds.has("buffer")) return { ok: false, reason: "buffer-pending" };
      return { ok: true, release: holdSharedBuffer(shared.handle) };
    },
    create: text => {
      const author = shared.author.next(); if (!author) return { ok: false, reason: "empty-script-no-author" };
      const raw = order.at(0), first = raw === undefined ? null : readSharedContentRef(raw);
      if (raw !== undefined && !first) return { ok: false, reason: "empty-script-placement-unavailable" };
      const id = readSharedContentRef(author.id), rowId = readSharedContentRef(sharedStructureIdentity(shared.writer(), author.id, "beat"));
      if (!id || !rowId) return { ok: false, reason: "empty-script-identity-unavailable" };
      const result = shared.session.run(emptyScriptCommand(text, { ...shared.stamps, author: { ...author, id },
        created: rowId, gap: { left: null, right: first, affinity: "before" } }));
      if (result.kind === "failed") throw result.error;
      return result.kind === "applied" || result.kind === "committed" ? { ok: true, rowId } : { ok: false, reason: result.kind === "rejected" ? result.reason : "empty-script-no-change" };
    }
  });
}
