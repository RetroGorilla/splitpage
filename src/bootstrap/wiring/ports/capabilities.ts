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

export const capabilities: CapabilityPort = {
  edit: () => currentCapabilities().edit(),
  comment: () => currentCapabilities().comment(),
  saveDestinations: () => currentCapabilities().saveDestinations(),
  autosave: () => currentCapabilities().autosave(),
  merge: () => currentCapabilities().merge(),
  reload: () => currentCapabilities().reload(),
  stash: () => currentCapabilities().stash(),
  drafts: () => currentCapabilities().drafts(),
  history: () => currentCapabilities().history(),
  folders: () => currentCapabilities().folders(),
  bundles: () => currentCapabilities().bundles(),
  moves: () => currentCapabilities().moves()
};

const entryReads = Object.fromEntries((Object.keys(SHARED_SESSION_DISABLED) as StandaloneCapabilityName[])
  .map(name => [name, entryRead(() => capabilities[name]())])) as Pick<CapabilityPort, StandaloneCapabilityName>;

export const entryCapabilities: EntryCapabilityPort = {
  ...entryReads,
  edit: capabilities.edit,
  comment: capabilities.comment,
  documentEntry: entryRead(() => AVAILABLE),
  lastFileResume: entryRead(() => sharedSession() ? SHARED_RESUME : AVAILABLE)
};
