import type { DesktopSharedScriptReference } from "../../../shared/desktop-contract.d.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../adapters/desktop/desktop-port.ts";
import { startupReady } from "../../application/startup-signal.ts";
import { waitDuringLifetime } from "../startup/page-lifetime.ts";
import { captureDocumentOpeningLifetime } from "./transition-owners.ts";
import { notices } from "./ports/effects.ts";
import { RETAINED_SHARED_COPY_UNAVAILABLE } from "./retained-shared-script.ts";
import type { RetainedSharedScript } from "./retained-shared-script.ts";
import type { SharedSwitchOutcome } from "./shared-session.ts";

declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

export async function resumeDesktopReference(
  reference: NonNullable<DesktopPort["sharedReference"]>,
  open: (saved: DesktopSharedScriptReference) => Promise<SharedSwitchOutcome>,
  signal: AbortSignal,
  clearFailedRestore = false
): Promise<SharedSwitchOutcome | null> {
  const saved = await reference([]);
  if (!saved || typeof saved !== "object" || signal.aborted) return null;
  let outcome: SharedSwitchOutcome | undefined;
  try {
    outcome = await open(saved);
    return outcome;
  } finally {
    const unavailable = outcome?.ok === false && outcome.reason === RETAINED_SHARED_COPY_UNAVAILABLE;
    if (!signal.aborted && (unavailable || (clearFailedRestore && outcome?.ok !== true))) {
      await reference([null, saved]).catch(() => false);
    }
  }
}

function startResume(enter: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>): () => void {
  const desktop = desktopPort();
  const reference = desktop?.sharedReference;
  const ready = startupReady();
  if (!reference || !ready) return () => {};
  const lifetime = new AbortController();
  const { signal } = lifetime;
  void resumeDesktopReference(reference, async ({ deployment, script, address }) => {
    await waitDuringLifetime(ready, signal);
    const opening = captureDocumentOpeningLifetime();
    const entrySignal = AbortSignal.any([signal, opening.signal]);
    await waitDuringLifetime(opening.settled, entrySignal);
    entrySignal.throwIfAborted();
    let endpoint: URL;
    try { endpoint = new URL(address); }
    catch { return { ok: false, reason: RETAINED_SHARED_COPY_UNAVAILABLE }; }
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return { ok: false, reason: RETAINED_SHARED_COPY_UNAVAILABLE };
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return enter({ deployment, script, relayUrl: endpoint.href, signal: entrySignal });
  }, signal, desktop.launchIntent.type === "open-shared").then(outcome => {
    if (outcome?.ok === false && !signal.aborted) notices.show("Could not reopen the local shared script.", "warn", true);
  }, error => { if (!signal.aborted) console.error(error); });
  return () => { lifetime.abort(); };
}

export const startDesktopSharedResume = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? startResume : () => () => {};
