import { createDraftWriter } from "../application/recovery/draft-writer.ts";
import type { DraftWriter } from "../application/recovery/draft-writer.ts";
import { restoreOwnership } from "../application/recovery/restore-policy.ts";
import type { DesktopDraftStore, DraftLimits, KeyedDraftStore } from "../application/recovery/ports.ts";
import { createConflictStash } from "../application/recovery/conflict-stash.ts";
import type { ConflictStash, KeyValueStorage } from "../application/recovery/conflict-stash.ts";
import { createDraftResume } from "../application/recovery/draft-resume.ts";
import type { DraftResume } from "../application/recovery/draft-resume.ts";
import { createLegacySnapshots } from "../application/recovery/legacy-snapshots.ts";
import type { LegacySnapshots } from "../application/recovery/legacy-snapshots.ts";
import { createDesktopDraftStore } from "../adapters/storage/draft-store-desktop.ts";
import type { DesktopDraftBridge } from "../adapters/storage/draft-store-desktop.ts";
import { createIdbDraftStore } from "../adapters/storage/draft-store-idb.ts";
import type { OperationContext } from "../application/session/operation.ts";
import { captureOperation, stillOwns } from "./transition-bridge.ts";

export interface LegacyRecoveryPorts {
  readonly indexedDB: IDBFactory | null;
  readonly limits: DraftLimits;
  readonly now: () => number;
  readonly writerId: string;
  readonly desktop: () => DesktopDraftBridge | null | undefined;
  readonly sessionStorage: () => KeyValueStorage | null | undefined;
  readonly localStorage: () => KeyValueStorage | null | undefined;
  readonly internImage: (dataUrl: string) => void;
}

export interface BrowserDrafts {
  readonly store: KeyedDraftStore;
  readonly writer: DraftWriter;
}

interface Started {
  readonly ports: LegacyRecoveryPorts;
  readonly desktop: DesktopDraftStore;
  readonly resume: DraftResume;
  readonly stash: ConflictStash;
  readonly snapshots: LegacySnapshots;
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
    resume: createDraftResume(),
    stash: createConflictStash({ storage: ports.sessionStorage, internImage: ports.internImage }),
    snapshots: createLegacySnapshots({ storage: ports.localStorage }),
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

export function draftResume(): DraftResume {
  return running().resume;
}

export function conflictStash(): ConflictStash {
  return running().stash;
}

export function legacySnapshots(): LegacySnapshots {
  return running().snapshots;
}

export function useBrowserDraftFactory(factory: IDBFactory | null): BrowserDrafts {
  const now = running();
  now.browser = browserDraftsFor(now.ports, factory);
  return now.browser;
}

const restoring = restoreOwnership({ capture: captureOperation, stillOwns: stillOwns });

export function captureRestore(): OperationContext {
  return restoring.capture();
}

export function stillRestoring(ctx: OperationContext): boolean {
  return restoring.stillOwns(ctx);
}
