import type { DocumentIdentityPorts } from "../../../application/identity/ports.ts";
import { currentDocument } from "../session-owner.ts";
import { currentHome, documentLocation } from "../location-owner.ts";
import { historyOwner } from "../history.ts";
import { stamping } from "./document.ts";
import { notices } from "./effects.ts";
import { presence } from "./desktop-presence.ts";
import { mintDocId, randomHexBytes } from "../../../adapters/identity/ids.ts";

export function documentIdentityPorts(): DocumentIdentityPorts {
  return {
    session: { currentDocument, stampDocument: stamping.stamp },
    location: { home: currentHome, writtenOut: () => documentLocation().writtenOut(), markWrittenOut: (value) => documentLocation().markWrittenOut(value) },
    history: { copyHistory: (from, to) => historyOwner().copyHistory(from, to), historyDocumentChanged: () => historyOwner().historyDocumentChanged() },
    effects: notices,
    desktop: { running: presence.running },
    ids: { docId: mintDocId, randomHexBytes },
    now: () => Date.now(),
    logger: { error: (error) => { if (window.console) console.error(error); } },
    channel: (name) => typeof BroadcastChannel === "function" ? new BroadcastChannel(name) as unknown as NonNullable<ReturnType<DocumentIdentityPorts["channel"]>> : null
  };
}
