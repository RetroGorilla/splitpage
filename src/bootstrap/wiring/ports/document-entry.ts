import type { DocumentEntryAdmission } from "../../../application/transitions/ports.ts";
import { sessionEntryRefusal, sharedSession } from "../session-owner.ts";
import { leaveRunningSharedSession } from "../shared-session.ts";
import { notices } from "./effects.ts";

export const documentEntry: DocumentEntryAdmission = { before: () => {
  const held = sessionEntryRefusal();
  if (!held && !sharedSession()) return null;
  const result = held ? { ok: false, reason: held } as const : leaveRunningSharedSession();
  if (result.ok) return null;
  notices.show("This is not available in a shared session yet.", "warn");
  return { refused: result.reason };
} };
