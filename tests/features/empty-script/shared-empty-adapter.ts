import { emptyScriptCommand } from "../../../src/application/commands/empty-script.ts";
import type { SharedDocumentSession } from "../../../src/application/session/shared-session.ts";
import type { StampPorts } from "../../../src/application/session/ports.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { EmptyScriptPorts } from "../../../src/features/empty-script/ports.ts";
import { startEmptyScript } from "../../../src/features/empty-script/empty-script.ts";
import { holdSharedBuffer } from "../../../src/adapters/collab/ingress.ts";
import { observeSharedStructureOrder } from "../../../src/adapters/collab/structure-order-index.ts";
import { sharedStructureKey } from "../../../src/core/collab/structure-key.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { readSharedContentRef } from "../../../src/core/collab/read-operation.ts";
import type { SharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import type { NoticePort } from "../../../src/application/effects/ports.ts";
import { sharedCommandReport } from "../../../src/bootstrap/wiring/ports/shared-command-notices.ts";

export function mountSharedEmptyScript(shared: {
  readonly handle: SharedDocumentHandle;
  readonly session: Pick<SharedDocumentSession, "read" | "run" | "epoch" | "subscribe" | "beforeCommand">;
  readonly author: SharedAuthorPort;
  readonly writer: () => string;
  readonly stamps: StampPorts;
}, surface: Pick<EmptyScriptPorts, "host" | "edits" | "report" | "place" | "abandonment"> &{ readonly notices: Pick<NoticePort, "show"> }) {
  const order = observeSharedStructureOrder(shared.handle);
  return startEmptyScript({ ...surface, report: sharedCommandReport(surface.notices, surface.report), lifetime: shared.session,
    document: { current: () => shared.session.read(doc => doc), onChange: shared.session.subscribe },
    hold: () => {
      if (collabState(shared.handle).ingress.holds.has("buffer")) return { ok: false, reason: "buffer-pending" };
      return { ok: true, release: holdSharedBuffer(shared.handle) };
    },
    create: text => {
      const author = shared.author.next(); if (!author) return { ok: false, reason: "empty-script-no-author" };
      const raw = order.at(0), first = raw === undefined ? null : readSharedContentRef(raw);
      if (raw !== undefined && !first) return { ok: false, reason: "empty-script-placement-unavailable" };
      const id = readSharedContentRef(author.id), rowId = readSharedContentRef(sharedStructureKey(shared.writer(), author.id, "beat"));
      if (!id || !rowId) return { ok: false, reason: "empty-script-identity-unavailable" };
      const result = shared.session.run(emptyScriptCommand(text, { ...shared.stamps, author: { ...author, id },
        created: rowId, gap: { left: null, right: first, affinity: "before" } }));
      if (result.kind === "failed") throw result.error;
      return result.kind === "applied" || result.kind === "committed" ? { ok: true, rowId } : result.kind === "rejected" ? { ...result, ok: false } : { ok: false, reason: "empty-script-no-change" };
    }
  });
}
