import type { DraftResume } from "../../../application/recovery/draft-resume.ts";
import type { SeedCheck } from "../../../application/preferences/seed-check.ts";
import { draftResume as currentDraftResume } from "../../../legacy/recovery-bridge.ts";
import { seedCheckPasses } from "../../../legacy/seed-check.ts";
import type { StartupSignal } from "../../../application/startup-signal.ts";
import { startupReady } from "../../../legacy/startup-bridge.ts";

export const startup: StartupSignal = {
  ready: () => startupReady()
};

export const draftResume: Pick<DraftResume, "restorePending"> = {
  restorePending: () => currentDraftResume().restorePending()
};

export const seedCheck: SeedCheck = { passes: () => seedCheckPasses() };
