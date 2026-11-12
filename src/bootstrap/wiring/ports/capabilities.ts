import type { CapabilityPort } from "../../../application/session/ports.ts";
import { currentCapabilities } from "../session-owner.ts";

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
  bundles: () => currentCapabilities().bundles()
};
