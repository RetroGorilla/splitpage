import { SHARED_SESSION_DISABLED } from "../../../application/session/ports.ts";
import type { Capability, CapabilityPort, StandaloneCapabilityName } from "../../../application/session/ports.ts";
import { currentCapabilities, sessionEntryRefusal, sharedSession } from "../session-owner.ts";

export interface EntryCapabilityPort extends CapabilityPort {
  readonly documentEntry: () => Capability;
  readonly lastFileResume: () => Capability;
}

const AVAILABLE: Capability = Object.freeze({ allowed: true });
const SHARED_RESUME: Capability = Object.freeze({ allowed: false, reason: "last-file-resume-shared" });

function entryRead(read: () => Capability): () => Capability {
  return () => {
    const holdReason = sessionEntryRefusal();
    return holdReason ? { allowed: false, reason: holdReason } : read();
  };
}

const standaloneReads = Object.fromEntries((Object.keys(SHARED_SESSION_DISABLED) as StandaloneCapabilityName[])
  .map(name => [name, entryRead(() => currentCapabilities()[name]())])) as Pick<CapabilityPort, StandaloneCapabilityName>;

export const capabilities: EntryCapabilityPort = {
  ...standaloneReads,
  edit: () => currentCapabilities().edit(),
  comment: () => currentCapabilities().comment(),
  documentEntry: entryRead(() => AVAILABLE),
  lastFileResume: entryRead(() => sharedSession() ? SHARED_RESUME : AVAILABLE)
};
