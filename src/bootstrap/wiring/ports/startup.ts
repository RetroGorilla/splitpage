import type { DraftResume } from "../../../application/recovery/draft-resume.ts";
import type { DraftsMount } from "../../../application/recovery/drafts-ports.ts";
import type { SeedCheck } from "../../../application/preferences/seed-check.ts";
import { draftResume as currentDraftResume, noteDraftChange } from "../../../legacy/recovery-bridge.ts";
import { seedCheckPasses } from "../../../adapters/page/seed-check.ts";
import type { StartupSignal } from "../../../application/startup-signal.ts";
import { startupReady } from "../../../application/startup-signal.ts";

export const startup: StartupSignal = {
  ready: () => startupReady()
};

export const draftResume: Pick<DraftResume, "restorePending"> = {
  restorePending: () => currentDraftResume().restorePending()
};

export const draftChanges: Pick<DraftsMount, "noteChange"> = {
  noteChange: () => { noteDraftChange(); }
};

export const seedCheck: SeedCheck = { passes: () => seedCheckPasses() };
