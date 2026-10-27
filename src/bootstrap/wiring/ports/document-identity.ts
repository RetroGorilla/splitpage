import type { DocumentIdentityPorts } from "../../../application/identity/ports.ts";
import { currentDocument, stampDocument } from "../../../legacy/session-bridge.ts";
import { currentHome, documentLocation, onServerDoc } from "../../../legacy/location-bridge.ts";
import { historyOwner } from "../history.ts";
import { notices } from "./effects.ts";
import { runningOnDesktop } from "../../../application/desktop-presence.ts";
import { mintDocId, randomHexBytes } from "../../../adapters/identity/ids.ts";

export function documentIdentityPorts(): DocumentIdentityPorts {
  return {
    session: { currentDocument, stampDocument },
    location: { home: currentHome, writtenOut: () => documentLocation().writtenOut(), markWrittenOut: (value) => documentLocation().markWrittenOut(value), onServerDoc },
    history: { copyHistory: (from, to) => historyOwner().copyHistory(from, to), historyDocumentChanged: () => historyOwner().historyDocumentChanged() },
    effects: notices,
    desktop: { running: runningOnDesktop },
    ids: { docId: mintDocId, randomHexBytes },
    now: () => Date.now(),
    logger: { error: (error) => { if (window.console) console.error(error); } },
    channel: (name) => typeof BroadcastChannel === "function" ? new BroadcastChannel(name) as unknown as NonNullable<ReturnType<DocumentIdentityPorts["channel"]>> : null
  };
}
