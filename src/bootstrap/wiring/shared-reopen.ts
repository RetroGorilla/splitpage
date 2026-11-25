import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { startupReady } from "../../application/startup-signal.ts";
import type { SharedScriptCatalogueEntry } from "../../../shared/shared-script.ts";
import { newTabControls } from "./newtab.ts";
import { notices } from "./ports/effects.ts";
import { sharedEntry } from "./shared-entry.ts";
import { captureDocumentOpeningLifetime } from "./transition-owners.ts";
import { draftResume } from "./recovery-owners.ts";
import { currentHome } from "./location-owner.ts";
import { holdDesktopDocumentPublication } from "./desktop-owners.ts";
import { browserScriptsOnThisDevice, wireBrowserSharedOpen } from "./ports/shared-scripts.ts";

async function reopenSharedScript(entry: SharedScriptCatalogueEntry, lifetime?: AbortSignal): Promise<void> {
  const publish = holdDesktopDocumentPublication();
  try {
    const result = await sharedEntry()?.enter(entry, lifetime);
    if (lifetime?.aborted) return;
    if (result?.ok) newTabControls()?.closeNewTabPage();
    else if (result?.reason !== "locked") notices.show("Could not reopen this shared script. Check that its local copy is still on this device.", "warn");
  } finally { publish(); }
}

export function startSharedReopen(hasInvitation: boolean): () => void {
  const lifetime = new AbortController();
  wireBrowserSharedOpen(async entry => {
    const opening = captureDocumentOpeningLifetime();
    await opening.settled;
    const signal = AbortSignal.any([lifetime.signal, opening.signal]);
    if (!signal.aborted) await reopenSharedScript(entry, signal);
  });
  const intent = desktopPort()?.launchIntent;
  const opening = async () => {
    if (hasInvitation) return;
    await startupReady();
    if (lifetime.signal.aborted) return;
    const documentOpening = captureDocumentOpeningLifetime();
    const signal = AbortSignal.any([lifetime.signal, documentOpening.signal]);
    await documentOpening.settled;
    if (signal.aborted) return;
    if (intent?.type === "open-shared" && intent.shared) {
      await reopenSharedScript(intent.shared, signal);
    } else if (!intent && !draftResume().restorePending() && currentHome().kind === "none") {
      const [last] = await browserScriptsOnThisDevice();
      if (last && !signal.aborted && currentHome().kind === "none") await reopenSharedScript(last, signal);
    }
  };
  void opening().catch(() => {});
  return () => { lifetime.abort(); wireBrowserSharedOpen(undefined); };
}
