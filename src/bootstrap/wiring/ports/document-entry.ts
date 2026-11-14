import type { DocumentEntryAdmission } from "../../../application/transitions/ports.ts";
import { sharedSession } from "../session-owner.ts";
import { leaveRunningSharedSession } from "../shared-session.ts";
import { notices } from "./effects.ts";

export const documentEntry: DocumentEntryAdmission = { before: () => {
  if (!sharedSession()) return null;
  const result = leaveRunningSharedSession();
  if (result.ok) return null;
  notices.show("This is not available in a shared session yet.", "warn");
  return { refused: result.reason };
} };
