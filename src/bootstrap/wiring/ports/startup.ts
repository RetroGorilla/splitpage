import type { DraftResume } from "../../../application/recovery/draft-resume.ts";
import type { DraftsMount } from "../../../application/recovery/drafts-ports.ts";
import type { SeedCheck } from "../../../application/preferences/seed-check.ts";
import { draftResume as currentDraftResume, noteDraftChange } from "../recovery-owners.ts";
import { seedCheckPasses } from "../../../adapters/page/seed-check.ts";
import type { StartupSignal } from "../../../application/startup-signal.ts";
import { startupReady } from "../../../application/startup-signal.ts";
import { whenDocumentReady } from "../../startup/dom-ready.ts";

export const startup: StartupSignal = {
  ready: () => startupReady()
};

export const domStartup: StartupSignal = {
  ready: async () => {
    // why: Native readiness events can run promise continuations before later startup listeners.
    await new Promise<void>(resolve => { whenDocumentReady(document, () => { setTimeout(resolve, 0); }); });
    const ready = startupReady();
    if (!ready) throw new Error("The app has not started yet");
    return ready;
  }
};

export const draftResume: Pick<DraftResume, "restorePending"> = {
  restorePending: () => currentDraftResume().restorePending()
};

export const draftChanges: Pick<DraftsMount, "noteChange"> = {
  noteChange: () => { noteDraftChange(); }
};

export const seedCheck: SeedCheck = { passes: () => seedCheckPasses() };
