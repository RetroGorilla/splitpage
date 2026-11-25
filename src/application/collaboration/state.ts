import type { OfflineClash, OfflineClashEntry, OfflineSavedBeat } from "./offline-clashes.ts";
import { canonicalSourceJson } from "../../core/document/load-ids.ts";

function savedContent({ narration, visual, fields, joined }: OfflineSavedBeat): string {
  return canonicalSourceJson({ narration, visual, fields, joined });
}

export type CollaborationPermanentRefusal =
  | "access-removed"
  | "invitation-revoked"
  | "script-deleted"
  | "script-unknown"
  | "permission-denied"
  | "unsupported-version";

export interface CollaborationLocalWriteError {
  readonly reason: string;
  readonly message: string;
  readonly code?: string;
}

export interface CollaborationRelayState {
  readonly connected: boolean;
  readonly firstSyncDone: boolean;
  readonly pendingChangeCount: number;
}

export interface CollaborationPictureCounts {
  readonly checking: number;
  readonly uploading: number;
  readonly downloading: number;
}

export interface CollaborationSnapshot {
  readonly active: boolean;
  readonly localPending: boolean;
  readonly localWriteError: CollaborationLocalWriteError | null;
  readonly relay: CollaborationRelayState;
  readonly pictures: CollaborationPictureCounts;
  readonly refusal: CollaborationPermanentRefusal | null;
  readonly mergeTooLarge: string | null;
  readonly offlineClashes: readonly OfflineClashEntry[];
}

export interface CollaborationReads {
  readonly snapshot: () => CollaborationSnapshot;
  readonly onChange: (listener: (snapshot: CollaborationSnapshot) => void) => () => void;
}

export interface CollaborationState extends CollaborationReads {
  readonly enter: (initial?: Partial<Omit<CollaborationSnapshot, "active">>) => void;
  readonly leave: () => void;
  readonly setLocalPending: (pending: boolean) => void;
  readonly setLocalWriteError: (error: CollaborationLocalWriteError | null) => void;
  readonly setRelay: (relay: CollaborationRelayState) => void;
  readonly setPictures: (pictures: CollaborationPictureCounts) => void;
  readonly setRefusal: (reason: CollaborationPermanentRefusal) => void;
  readonly clearRefusal: () => void;
  readonly setMergeTooLarge: (message: string) => void;
  readonly setOfflineClashes: (clashes: readonly OfflineClash[]) => void;
  readonly dismissOfflineClashes: () => void;
  readonly restoreOfflineClash: (entry: OfflineClashEntry, write: (beat: OfflineSavedBeat) => boolean) => boolean;
}

export const PERMANENT_COLLABORATION_REFUSALS: readonly CollaborationPermanentRefusal[] = Object.freeze([
  "access-removed",
  "invitation-revoked",
  "script-deleted",
  "script-unknown",
  "permission-denied",
  "unsupported-version"
]);

export const MERGE_TOO_LARGE_MESSAGE = "Your changes could not sync because combining the copies would exceed the 15 MB limit. You can still read your local copy. Export it as a fresh .splitpage project to start a new shared session.";

export const IDLE_COLLABORATION_SNAPSHOT: CollaborationSnapshot = Object.freeze({
  active: false,
  localPending: false,
  localWriteError: null,
  relay: Object.freeze({ connected: false, firstSyncDone: false, pendingChangeCount: 0 }),
  pictures: Object.freeze({ checking: 0, uploading: 0, downloading: 0 }),
  refusal: null,
  mergeTooLarge: null,
  offlineClashes: Object.freeze([])
});

export function isPermanentCollaborationRefusal(reason: string): reason is CollaborationPermanentRefusal {
  return (PERMANENT_COLLABORATION_REFUSALS as readonly string[]).includes(reason);
}

export function localWriteErrorMessage(reason: string): string {
  if (reason === "quota") return "This device is out of storage space — free some space and try again, or export a copy.";
  if (reason === "closed" || reason === "version") return "Storage on this device was interrupted — try again, or export a copy.";
  if (reason === "locked" || reason === "blocked") return "This shared script is busy in another tab — close the other tab and try again, or export a copy.";
  return "Could not write to storage on this device — check free space and try again, or export a copy.";
}

export function accessRemovedMessage(reason: CollaborationPermanentRefusal): string {
  if (reason === "script-deleted" || reason === "script-unknown") {
    return "This shared script was deleted or is no longer available on the relay. Your copy on this device is still readable — export a copy before leaving.";
  }
  if (reason === "unsupported-version") {
    return "This shared script needs a newer version of Splitpage to sync. Your copy on this device is still readable — export a copy before leaving.";
  }
  return "Your access to this shared script was removed. Your copy on this device is still readable — export a copy before leaving.";
}

function sameError(a: CollaborationLocalWriteError | null, b: CollaborationLocalWriteError | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.reason === b.reason && a.message === b.message && a.code === b.code;
}

function sameRelay(a: CollaborationRelayState, b: CollaborationRelayState): boolean {
  return a.connected === b.connected && a.firstSyncDone === b.firstSyncDone && a.pendingChangeCount === b.pendingChangeCount;
}

function samePictures(a: CollaborationPictureCounts, b: CollaborationPictureCounts): boolean {
  return a.checking === b.checking && a.uploading === b.uploading && a.downloading === b.downloading;
}

function sameSnapshot(a: CollaborationSnapshot, b: CollaborationSnapshot): boolean {
  return a.active === b.active
    && a.localPending === b.localPending
    && sameError(a.localWriteError, b.localWriteError)
    && sameRelay(a.relay, b.relay)
    && samePictures(a.pictures, b.pictures)
    && a.refusal === b.refusal
    && a.mergeTooLarge === b.mergeTooLarge
    && a.offlineClashes === b.offlineClashes;
}

function freezeRelay(relay: CollaborationRelayState): CollaborationRelayState {
  return Object.freeze({
    connected: !!relay.connected,
    firstSyncDone: !!relay.firstSyncDone,
    pendingChangeCount: Math.max(0, Math.floor(relay.pendingChangeCount || 0))
  });
}

function freezePictures(pictures: CollaborationPictureCounts): CollaborationPictureCounts {
  return Object.freeze({
    checking: Math.max(0, Math.floor(pictures.checking || 0)),
    uploading: Math.max(0, Math.floor(pictures.uploading || 0)),
    downloading: Math.max(0, Math.floor(pictures.downloading || 0))
  });
}

function freezeError(error: CollaborationLocalWriteError | null): CollaborationLocalWriteError | null {
  if (!error) return null;
  return Object.freeze(error.code === undefined
    ? { reason: error.reason, message: error.message }
    : { reason: error.reason, message: error.message, code: error.code });
}

export function createCollaborationState(): CollaborationState {
  let current: CollaborationSnapshot = IDLE_COLLABORATION_SNAPSHOT;
  const listeners = new Set<(snapshot: CollaborationSnapshot) => void>();
  const restoring = new Set<OfflineClashEntry>();

  function update(next: CollaborationSnapshot): void {
    if (sameSnapshot(current, next)) return;
    current = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener(current);
      } catch {
        continue;
      }
    }
  }

  const state: CollaborationState = {
    snapshot: () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    enter(initial) {
      update({
        active: true,
        localPending: !!initial?.localPending,
        localWriteError: freezeError(initial?.localWriteError ?? null),
        relay: freezeRelay(initial?.relay ?? IDLE_COLLABORATION_SNAPSHOT.relay),
        pictures: freezePictures(initial?.pictures ?? IDLE_COLLABORATION_SNAPSHOT.pictures),
        refusal: initial?.refusal ?? null,
        mergeTooLarge: initial?.mergeTooLarge ?? null,
        offlineClashes: IDLE_COLLABORATION_SNAPSHOT.offlineClashes
      });
    },
    leave() {
      update(IDLE_COLLABORATION_SNAPSHOT);
    },
    setLocalPending(pending) {
      if (!current.active) return;
      update({ ...current, localPending: !!pending });
    },
    setLocalWriteError(error) {
      if (!current.active) return;
      update({ ...current, localWriteError: freezeError(error) });
    },
    setRelay(relay) {
      if (!current.active || current.refusal || current.mergeTooLarge) return;
      update({
        ...current,
        relay: freezeRelay(relay)
      });
    },
    setPictures(pictures) {
      if (!current.active) return;
      update({ ...current, pictures: freezePictures(pictures) });
    },
    clearRefusal() {
      if (!current.active) return;
      if (current.refusal) update({ ...current, refusal: null });
    },
    setRefusal(reason) {
      if (!current.active) return;
      update({
        ...current,
        refusal: reason,
        pictures: IDLE_COLLABORATION_SNAPSHOT.pictures,
        relay: freezeRelay({ connected: false, firstSyncDone: false, pendingChangeCount: current.relay.pendingChangeCount })
      });
    },
    setMergeTooLarge(message) {
      if (!current.active) return;
      update({
        ...current,
        mergeTooLarge: message || MERGE_TOO_LARGE_MESSAGE,
        pictures: IDLE_COLLABORATION_SNAPSHOT.pictures,
        relay: freezeRelay({ connected: false, firstSyncDone: false, pendingChangeCount: current.relay.pendingChangeCount })
      });
    },
    setOfflineClashes(clashes) {
      if (!current.active || !clashes.length) return;
      const entries = new Map(current.offlineClashes.map(entry => [entry.id, entry]));
      for (const { id, mine, near } of clashes) {
        const previous = entries.get(id);
        const restored = !!(previous?.restored && previous.mine && mine && savedContent(previous.mine) === savedContent(mine));
        entries.set(id, Object.freeze({ id, mine, ...(near === undefined ? {} : { near }), restored }));
      }
      update({ ...current, offlineClashes: Object.freeze([...entries.values()]) });
    },
    dismissOfflineClashes() {
      update({ ...current, offlineClashes: IDLE_COLLABORATION_SNAPSHOT.offlineClashes });
    },
    restoreOfflineClash(entry, write) {
      if (!entry.mine || entry.restored || restoring.has(entry) || !current.offlineClashes.includes(entry)) return false;
      restoring.add(entry);
      try {
        if (!write(entry.mine)) return false;
        const entries = current.offlineClashes;
        if (entries.includes(entry)) {
          const restored = Object.freeze({ ...entry, restored: true });
          update({ ...current, offlineClashes: Object.freeze(entries.map(item => item === entry ? restored : item)) });
        }
        return true;
      } finally { restoring.delete(entry); }
    }
  };
  return Object.freeze(state);
}
