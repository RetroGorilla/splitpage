import type { DocumentEntryAdmission } from "../../../application/transitions/ports.ts";
import { sharedSession } from "../session-owner.ts";
import { leaveRunningSharedSession } from "../shared-session.ts";
import { notices } from "./effects.ts";
import { capabilities } from "./capabilities.ts";

export const documentEntry: DocumentEntryAdmission = { before: () => {
  const permission = capabilities.documentEntry();
  if (permission.allowed && !sharedSession()) return null;
  const result = permission.allowed ? leaveRunningSharedSession() : { ok: false, reason: permission.reason } as const;
  if (result.ok) return null;
  notices.show("This is not available in a shared session yet.", "warn");
  return { refused: result.reason };
} };
