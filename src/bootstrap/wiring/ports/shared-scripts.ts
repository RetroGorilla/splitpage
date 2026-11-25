import { createBrowserSharedCatalogue } from "../../../adapters/collab/native/browser-local-store.ts";
import { desktopPort } from "../../../adapters/desktop/desktop-port.ts";
import { createSharedScriptCatalogue } from "../../../application/collaboration/shared-script-catalogue.ts";
import { sharedScriptKey } from "../../../../shared/shared-script.ts";
import type { SharedScriptCatalogueEntry } from "../../../../shared/shared-script.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

export function browserSharedCatalogue() {
  return createSharedScriptCatalogue(createBrowserSharedCatalogue(), Date.now);
}

export async function browserScriptsOnThisDevice(): Promise<SharedScriptCatalogueEntry[]> {
  if (desktopPort()) return [];
  const relay = new URL(location.origin);
  const testRelay = typeof SPLITPAGE_TEST_HOOKS !== "undefined" && SPLITPAGE_TEST_HOOKS
    && relay.protocol === "http:" && relay.hostname === "127.0.0.1";
  if (relay.protocol !== "https:" && !testRelay) return [];
  relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
  return (await browserSharedCatalogue().list()).filter(entry => entry.relayUrl === relay.href);
}

let open: ((entry: SharedScriptCatalogueEntry) => Promise<void>) | undefined;

export function wireBrowserSharedOpen(reopen: typeof open): void { open = reopen; }

export async function openBrowserSharedScript(id: string): Promise<void> {
  const entries = await browserScriptsOnThisDevice().catch(() => []);
  const entry = entries.find(item => sharedScriptKey(item) === id);
  if (entry) await open?.(entry);
}
