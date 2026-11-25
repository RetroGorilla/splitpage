import type { DocumentEntryAdmission } from "../../../application/transitions/ports.ts";
import { sharedSession } from "../session-owner.ts";
import { leaveRunningSharedSession } from "../shared-session.ts";
import { desktopPort } from "../../../adapters/desktop/desktop-port.ts";
import { notices } from "./effects.ts";
import { entryCapabilities } from "./capabilities.ts";

declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

export const documentEntry: DocumentEntryAdmission = { before: () => {
  const permission = entryCapabilities.documentEntry();
  if (permission.allowed && !sharedSession()) return null;
  const result = permission.allowed ? leaveRunningSharedSession(false) : { ok: false, reason: permission.reason } as const;
  if (result.ok) {
    if (typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI) {
      const warn = () => { notices.show("Could not clear the shared script from this tab.", "warn"); };
      void desktopPort()?.sharedReference?.([null]).then(cleared => { if (cleared !== true) warn(); }, warn);
    }
    return null;
  }
  notices.show("This is not available in a shared session yet.", "warn");
  return { refused: result.reason };
} };
