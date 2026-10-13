import { createDraftWriter } from "../application/recovery/draft-writer.ts";
import type { DraftWriter } from "../application/recovery/draft-writer.ts";
import type { DesktopDraftStore, DraftLimits, KeyedDraftStore } from "../application/recovery/ports.ts";
import { createDesktopDraftStore } from "../adapters/storage/draft-store-desktop.ts";
import type { DesktopDraftBridge } from "../adapters/storage/draft-store-desktop.ts";
import { createIdbDraftStore } from "../adapters/storage/draft-store-idb.ts";
import { captureOperation, stillOwns } from "./transition-bridge.ts";

export interface LegacyRecoveryPorts {
  readonly indexedDB: IDBFactory | null;
  readonly limits: DraftLimits;
  readonly now: () => number;
  readonly writerId: string;
  readonly desktop: () => DesktopDraftBridge | null | undefined;
}

export interface BrowserDrafts {
  readonly store: KeyedDraftStore;
  readonly writer: DraftWriter;
}

interface Started {
  readonly ports: LegacyRecoveryPorts;
  readonly desktop: DesktopDraftStore;
  browser: BrowserDrafts;
}

let started: Started | null = null;

function running(): Started {
  if (!started) throw new Error("The draft recovery is not started yet");
  return started;
}

function browserDraftsFor(ports: LegacyRecoveryPorts, factory: IDBFactory | null): BrowserDrafts {
  const store = createIdbDraftStore({ indexedDB: factory, limits: ports.limits, now: ports.now });
  const writer = createDraftWriter({
    store: store,
    writerId: ports.writerId,
    ownership: { capture: captureOperation, stillOwns: stillOwns }
  });
  return Object.freeze({ store: store, writer: writer });
}

export function startRecovery(ports: LegacyRecoveryPorts): () => void {
  if (started) throw new Error("The draft recovery is already started; stop it first");
  const mine: Started = {
    ports: ports,
    desktop: createDesktopDraftStore({ bridge: ports.desktop }),
    browser: browserDraftsFor(ports, ports.indexedDB)
  };
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function recoveryStarted(): boolean {
  return started !== null;
}

export function browserDrafts(): BrowserDrafts {
  return running().browser;
}

export function desktopDrafts(): DesktopDraftStore {
  return running().desktop;
}

export function useBrowserDraftFactory(factory: IDBFactory | null): BrowserDrafts {
  const now = running();
  now.browser = browserDraftsFor(now.ports, factory);
  return now.browser;
}
