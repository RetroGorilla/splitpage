import type { DesktopSharedScriptReference } from "../../../shared/desktop-contract.d.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../adapters/desktop/desktop-port.ts";
import { startupReady } from "../../application/startup-signal.ts";
import { waitDuringLifetime } from "../startup/page-lifetime.ts";
import { captureDocumentOpeningLifetime } from "./transition-owners.ts";
import { notices } from "./ports/effects.ts";
import { relaySocketUrl } from "./relay-address.ts";
import { RETAINED_SHARED_COPY_UNAVAILABLE } from "./retained-shared-script.ts";
import type { RetainedSharedScript } from "./retained-shared-script.ts";
import type { SharedSwitchOutcome } from "./shared-session.ts";

declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

const INVALID_SAVED_RELAY = "invalid-saved-relay";

export async function resumeDesktopReference(
  reference: NonNullable<DesktopPort["sharedReference"]>,
  open: (saved: DesktopSharedScriptReference) => Promise<SharedSwitchOutcome>,
  signal: AbortSignal
): Promise<SharedSwitchOutcome | null> {
  const reply = await reference([]);
  if (!reply || typeof reply !== "object" || signal.aborted) return null;
  const { reserved, ...saved } = reply;
  let outcome: SharedSwitchOutcome | undefined;
  try {
    outcome = await open(saved);
    return outcome;
  } finally {
    const unavailable = outcome?.ok === false && outcome.reason === RETAINED_SHARED_COPY_UNAVAILABLE;
    const invalidRelay = outcome?.ok === false && outcome.reason === INVALID_SAVED_RELAY;
    if (!signal.aborted && (unavailable || invalidRelay || (reserved && outcome?.ok !== true))) {
      await reference(unavailable ? [null, saved, "unavailable"] : [null, saved]).catch(() => false);
    }
  }
}

export async function enterSavedReference(
  { deployment, script, address }: DesktopSharedScriptReference,
  enter: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>,
  settled: () => Promise<AbortSignal>
): Promise<SharedSwitchOutcome> {
  const relayUrl = relaySocketUrl(address);
  if (!relayUrl) return { ok: false, reason: INVALID_SAVED_RELAY };
  return enter({ deployment, script, relayUrl, signal: await settled() });
}

function startResume(enter: (entry: RetainedSharedScript) => Promise<SharedSwitchOutcome>): () => void {
  const reference = desktopPort()?.sharedReference;
  const ready = startupReady();
  if (!reference || !ready) return () => {};
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const settled = async () => {
    await waitDuringLifetime(ready, signal);
    const opening = captureDocumentOpeningLifetime();
    const entrySignal = AbortSignal.any([signal, opening.signal]);
    await waitDuringLifetime(opening.settled, entrySignal);
    entrySignal.throwIfAborted();
    return entrySignal;
  };
  void resumeDesktopReference(reference, saved => enterSavedReference(saved, enter, settled), signal).then(outcome => {
    if (outcome?.ok === false && !signal.aborted) notices.show("Could not reopen the local shared script.", "warn", true);
  }, error => { if (!signal.aborted) console.error(error); });
  return () => { lifetime.abort(); };
}

export const startDesktopSharedResume = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? startResume : () => () => {};
