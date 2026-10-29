import type { DesktopDraftStore } from "../../application/recovery/ports.ts";
import type { DraftFlush } from "../../application/recovery/drafts-ports.ts";
import { createConflictStash } from "../../application/recovery/conflict-stash.ts";
import type { ConflictStash, KeyValueStorage } from "../../application/recovery/conflict-stash.ts";
import { createDraftResume } from "../../application/recovery/draft-resume.ts";
import type { DraftResume } from "../../application/recovery/draft-resume.ts";
import { createLegacySnapshots } from "../../application/recovery/legacy-snapshots.ts";
import type { LegacySnapshots } from "../../application/recovery/legacy-snapshots.ts";
import { createLocalWorkStash, createStashedWork } from "../../application/recovery/stashed-work.ts";
import type { ApplyStashedWork, StashMerge } from "../../application/recovery/stashed-work.ts";
import { cloneState } from "../../core/document/clone.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { MergedStates } from "../../core/merge-states.ts";
import { migrateRows } from "../document-ports.ts";
import { documentLocation } from "./location-owner.ts";
import { createDesktopDraftStore } from "../../adapters/storage/draft-store-desktop.ts";
import type { DesktopDraftBridge } from "../../adapters/storage/draft-store-desktop.ts";
import type { OperationContext } from "../../application/session/operation.ts";
import { captureOperation, stillOwns } from "./transition-owners.ts";
import { currentDocument, mergeBase, sessionStamps } from "./session-owner.ts";
import { nowIso } from "../../adapters/identity/ids.ts";
import { dataUrlForSync, isDurableSync } from "../../adapters/storage/02c-blobs.js";

export interface LegacyRecoveryPorts {
  readonly desktop: () => DesktopDraftBridge | null | undefined;
  readonly sessionStorage: () => KeyValueStorage | null | undefined;
  readonly localStorage: () => KeyValueStorage | null | undefined;
  readonly internImage: (dataUrl: string) => void;
  readonly merge: StashMerge<ValidatedDocument, MergedStates>;
  readonly drafts: LegacyDraftPorts;
}

export interface LegacyDraftPorts {
  readonly flush: (opts?: { readonly keep?: boolean } | null) => Promise<DraftFlush>;
  readonly noteChange: () => void;
}

interface Started {
  readonly ports: LegacyRecoveryPorts;
  readonly desktop: DesktopDraftStore;
  readonly resume: DraftResume;
  readonly stash: ConflictStash;
  readonly snapshots: LegacySnapshots;
  readonly stashedWork: ApplyStashedWork<ValidatedDocument, MergedStates>;
  readonly stashLocal: () => boolean;
}

let started: Started | null = null;

function running(): Started {
  if (!started) throw new Error("The draft recovery is not started yet");
  return started;
}

export function startRecovery(ports: LegacyRecoveryPorts): () => void {
  if (started) throw new Error("The draft recovery is already started; stop it first");
  const stash = createConflictStash({ storage: ports.sessionStorage, internImage: ports.internImage });
  const mine: Started = {
    ports: ports,
    desktop: createDesktopDraftStore({ bridge: ports.desktop }),
    resume: createDraftResume(),
    stash: stash,
    stashedWork: createStashedWork<ValidatedDocument, MergedStates>({
      stash: stash,
      markWrittenOut: function () { documentLocation().markWrittenOut(true); },
      copy: function (doc) { return migrateRows(cloneState(doc)); },
      merge: ports.merge
    }),
    stashLocal: createLocalWorkStash<ValidatedDocument>({
      stash: stash,
      current: currentDocument,
      base: mergeBase,
      now: nowIso,
      editor: function () { return sessionStamps.editor.name(); },
      durable: isDurableSync,
      dataUrl: dataUrlForSync
    }),
    snapshots: createLegacySnapshots({ storage: ports.localStorage })
  };
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function recoveryStarted(): boolean {
  return started !== null;
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

export function applyStashedWork(...args: Parameters<ApplyStashedWork<ValidatedDocument, MergedStates>>): ReturnType<ApplyStashedWork<ValidatedDocument, MergedStates>> {
  return running().stashedWork(...args);
}

export function stashLocalWork(): boolean {
  return running().stashLocal();
}

export function flushDraftNow(opts?: { readonly keep?: boolean } | null): Promise<DraftFlush> {
  return running().ports.drafts.flush(opts);
}

export function noteDraftChange(): void {
  started?.ports.drafts.noteChange();
}

export function legacySnapshots(): LegacySnapshots {
  return running().snapshots;
}

export function captureRestore(): OperationContext {
  return captureOperation();
}

export function stillRestoring(ctx: OperationContext): boolean {
  return stillOwns(ctx);
}
