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
  signal: AbortSignal
): Promise<SharedSwitchOutcome | null> {
  const saved = await reference([]);
  if (!saved || typeof saved !== "object" || signal.aborted) return null;
  const outcome = await open(saved);
  if (!outcome.ok && outcome.reason === RETAINED_SHARED_COPY_UNAVAILABLE && !signal.aborted) {
    await reference([null, saved]).catch(() => false);
  }
  return outcome;
}

function startResume(enter: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>): () => void {
  const reference = desktopPort()?.sharedReference;
  const ready = startupReady();
  if (!reference || !ready) return () => {};
  const lifetime = new AbortController();
  const { signal } = lifetime;
  void resumeDesktopReference(reference, async ({ deployment, script, address }) => {
    await waitDuringLifetime(ready, signal);
    await waitDuringLifetime(captureDocumentOpeningLifetime().settled, signal);
    signal.throwIfAborted();
    let endpoint: URL;
    try { endpoint = new URL(address); }
    catch { return { ok: false, reason: RETAINED_SHARED_COPY_UNAVAILABLE }; }
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return { ok: false, reason: RETAINED_SHARED_COPY_UNAVAILABLE };
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return enter({ deployment, script, relayUrl: endpoint.href, signal });
  }, signal).then(outcome => {
    if (outcome?.ok === false && !signal.aborted) notices.show("Could not reopen the local shared script.", "warn", true);
  }, error => { if (!signal.aborted) console.error(error); });
  return () => { lifetime.abort(); };
}

export const startDesktopSharedResume = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? startResume : () => () => {};
