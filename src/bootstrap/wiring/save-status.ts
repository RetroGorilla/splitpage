import { documentIdentity } from "./ports/document-identity-controls.ts";
import type { Refusal } from "../../application/actions.ts";
import { mountSaveStatus } from "../../features/title/save-status.js";
import { showRefusal as showRefusalNotice } from "../../features/title/refusal.ts";
import type { DocumentIdentitySync, SaveStatusListeners, SaveStatusMount } from "../../features/title/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { notices } from "./ports/effects.ts";
import { place } from "./ports/location.ts";
import { saveStatusPreferences } from "./ports/preferences.ts";
import { autoSaves, saves } from "./ports/saving.ts";
import { draftChanges } from "./ports/startup.ts";

const saveStatus = owned<SaveStatusMount>();

export function mountSaveStatusFeature(identity: DocumentIdentitySync = { sync: () => documentIdentity.syncDocIdentity() }): SaveStatusMount {
  return saveStatus.replace(() => mountSaveStatus({
    saves,
    autoSave: autoSaves,
    place,
    preferences: saveStatusPreferences,
    notices,
    drafts: draftChanges,
    identity
  }));
}

export const stopSaveStatusFeature = saveStatus.stop;

export function updateSaveStatus(): void {
  saveStatus.owner()?.refresh();
}

export function showRefusal(refusal: Refusal): void {
  showRefusalNotice(notices, refusal);
}

export function saveStatusListeners(): SaveStatusListeners {
  return {
    paint: () => { saveStatus.owner()?.listeners().paint(); },
    save: (change) => { saveStatus.owner()?.listeners().save(change); },
    location: (change) => { saveStatus.owner()?.listeners().location(change); },
    status: (change) => { saveStatus.owner()?.listeners().status(change); },
    preference: (change) => { saveStatus.owner()?.listeners().preference(change); }
  };
}
