import type { SharedCommentPorts } from "../../../application/commands/comments.ts";
import type { SharedGalleryCommands } from "../../../application/commands/gallery.ts";
import type { SharedRecordCommands, SharedRecordPorts } from "../../../application/commands/shared-records.ts";
import type { SharedSettledSelection, SharedStructureCommands } from "../../../application/commands/shared-structure.ts";
import { sharedBufferedTarget } from "../../../adapters/collab/buffer.ts";
import { holdSharedCapture } from "../../../adapters/collab/ingress.ts";
import { locateSharedTextBoundary, readSharedTextBoundary, readSharedTextUnits } from "../../../adapters/collab/text-units.ts";
import { bufferedFieldKey } from "../../../core/collab/buffer.ts";
import type { SharedValueCommands } from "../../../application/commands/shared-values.ts";
import type { CommandOutcome } from "../../../application/session/document-session.ts";
import type { UndoControl } from "../../../application/editing/undo-control.ts";
import { sessionStamps, sessionTextPorts } from "../session-owner.ts";
import { sharedSessionParts } from "../shared-session.ts";
import type { SharedSessionParts } from "../shared-session.ts";
import { sharedUndoRoute, stepSharedUndo, undoOwner } from "../undo.ts";
import { notices } from "./effects.ts";
import { sharedCommandRefusalNotice } from "./shared-command-notices.ts";
import { sharedCommentPorts } from "./shared-comments.ts";
import { sharedGalleryPorts } from "./shared-gallery.ts";
import { sharedRecordPorts } from "./shared-records.ts";
import { sharedStructurePorts, sharedValuePorts } from "./shared-values.ts";
import { timingMarks } from "../../../../shared/timing-marks.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

const refuse = sharedCommandRefusalNotice(notices);
const SELECTION_SPANS = "split-selection-spans-beats", SELECTION_GONE = "split-selection-gone";

function refused(outcome: CommandOutcome): void {
  if (outcome.kind === "rejected" && !outcome.notified) refuse(outcome.reason);
}

function settle(): boolean {
  if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:input-command:start");
  try {
    const refusal = sharedSessionParts()?.session.admit() ?? null;
    if (refusal?.kind === "failed") throw refusal.error;
    if (refusal) refused(refusal);
    return refusal === null;
  } finally { if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:input-command:end"); }
}

function narration(parts: SharedSessionParts, rowId: string) {
  return sharedBufferedTarget(parts.handle, bufferedFieldKey(rowId, "audioText"));
}

function unitsOf(parts: SharedSessionParts, rowId: string): readonly string[] | null {
  try { return readSharedTextUnits(parts.handle, narration(parts, rowId)); }
  catch { return null; }
}

function boundaryOf(parts: SharedSessionParts, rowId: string, index: number): string | null {
  try { return readSharedTextBoundary(parts.handle, narration(parts, rowId), index); }
  catch { return null; }
}

function searchOrder(parts: SharedSessionParts, rowId: string): readonly string[] {
  const rows = parts.session.read(doc => doc ? doc.rows.map(row => row.id) : []);
  return rows.includes(rowId) ? [rowId, ...rows.filter(id => id !== rowId)] : rows;
}

function boundaryIn(parts: SharedSessionParts, rowId: string, boundary: string): number | null {
  try { return locateSharedTextBoundary(parts.handle, narration(parts, rowId), boundary); }
  catch { return null; }
}

function boundaryCut(parts: SharedSessionParts, rows: readonly string[], boundary: string | null): { readonly rowId: string; readonly at: number } | null {
  for (const id of boundary ? rows : []) {
    const at = boundaryIn(parts, id, boundary as string);
    if (at !== null) return { rowId: id, at };
  }
  return null;
}

function located(parts: SharedSessionParts, rowId: string, keys: readonly string[]): Map<string, { readonly rowId: string; readonly at: number }> {
  const found = new Map<string, { readonly rowId: string; readonly at: number }>();
  for (const id of searchOrder(parts, rowId)) {
    (unitsOf(parts, id) ?? []).forEach((key, at) => { if (keys.includes(key) && !found.has(key)) found.set(key, { rowId: id, at }); });
    if (keys.every(key => found.has(key))) break;
  }
  return found;
}

function runs(offsets: readonly number[]): (readonly [number, number])[] {
  const removed: [number, number][] = [];
  for (const at of offsets) {
    const last = removed.at(-1);
    if (last && last[1] === at) last[1] = at + 1;
    else removed.push([at, at + 1]);
  }
  return removed;
}

type SelectionRead = () => { readonly from: number; readonly to: number } | null;

function captureSeen(parts: SharedSessionParts, rowId: string, read: SelectionRead) {
  const release = holdSharedCapture(parts.handle);
  try {
    if (!settle()) return null;
    const range = read(), units = unitsOf(parts, rowId);
    if (!range || !units) return null;
    const start = range.from < range.to ? boundaryOf(parts, rowId, range.from) : null;
    return { selected: units.slice(range.from, range.to), after: units[range.from], before: units[range.from - 1], start };
  } finally { release(); }
}

function settleSelection(rowId: string, read: SelectionRead): SharedSettledSelection | null {
  if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:input-command:start");
  try { return settledSelection(rowId, read); }
  finally { if ((typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS) && timingMarks.marksOn) performance.mark("measure:input-command:end"); }
}

function settledSelection(rowId: string, read: SelectionRead): SharedSettledSelection | null {
  const parts = sharedSessionParts();
  if (!parts) return null;
  const seen = captureSeen(parts, rowId, read);
  if (!seen) return null;
  if (!seen.selected.length) {
    const near = [seen.after, seen.before].filter((key): key is string => !!key), found = located(parts, rowId, near);
    const after = seen.after ? found.get(seen.after) : undefined, before = seen.before ? found.get(seen.before) : undefined;
    const caret = after ?? (before ? { rowId: before.rowId, at: before.at + 1 } : null);
    if (caret) return { rowId: caret.rowId, removed: [], at: caret.at };
    if (!near.length && parts.session.read(doc => doc?.rows.some(row => row.id === rowId))) return { rowId, removed: [], at: 0 };
    refuse(SELECTION_GONE);
    return null;
  }
  const found = located(parts, rowId, seen.selected), places = seen.selected.flatMap(key => found.get(key) ?? []);
  const first = places[0];
  if (first && places.some(place => place.rowId !== first.rowId)) { refuse(SELECTION_SPANS); return null; }
  const offsets = places.map(place => place.at).sort((a, b) => a - b);
  // why: the cut is the boundary before the first seen character, which outlives that character's deletion
  const cut = boundaryCut(parts, first ? [first.rowId] : searchOrder(parts, rowId), seen.start) ?? (first ? { rowId: first.rowId, at: offsets[0] as number } : null);
  if (!cut) { refuse(SELECTION_GONE); return null; }
  return { rowId: cut.rowId, removed: runs(offsets), at: Math.min(cut.at, offsets[0] ?? cut.at) };
}

function source(parts: SharedSessionParts) {
  return { handle: () => sharedSessionParts() === parts ? parts.handle : null, author: () => parts.author.next(), stamps: sessionStamps };
}

export const sharedValueCommands: SharedValueCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedValuePorts(source(parts))() : null;
  },
  refused
};

const recordPorts = new WeakMap<SharedSessionParts, SharedRecordPorts>();

export const sharedRecordCommands: SharedRecordCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    if (!parts) return null;
    // why: one ports object per session, so a panel can tell a draft typed in this session from the next one
    const made = recordPorts.get(parts) ?? sharedRecordPorts(source(parts));
    recordPorts.set(parts, made);
    return made;
  },
  refused
};

export const sharedGalleryCommands: SharedGalleryCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedGalleryPorts(source(parts)) : null;
  },
  refused,
  done: message => { notices.show(message, "ok"); }
};

const commentPorts = new WeakMap<SharedSessionParts, SharedCommentPorts>();

export const sharedCommentCommands: SharedRecordCommands<SharedCommentPorts> = {
  ports: () => {
    const parts = sharedSessionParts();
    if (!parts) return null;
    const made = commentPorts.get(parts) ?? sharedCommentPorts({ ...source(parts), cells: html => sessionTextPorts.cells(html ?? "") })();
    if (made) commentPorts.set(parts, made);
    return made;
  },
  refused
};

export const sharedStructureCommands: SharedStructureCommands = {
  ports: () => {
    const parts = sharedSessionParts();
    return parts ? sharedStructurePorts({ ...source(parts), cells: html => sessionTextPorts.cells(html) })() : null;
  },
  refused,
  settle,
  settleSelection
};

// why: while shared the standalone owner refuses its held document, so a control's own Ctrl+Z steps the shared owner
export const sharedAwareUndo: Pick<UndoControl, "undo" | "redo"> = {
  undo: () => {
    const route = sharedUndoRoute();
    return route ? stepSharedUndo(route, "undo", message => { notices.show(message, "warn"); }) : undoOwner().undo();
  },
  redo: () => {
    const route = sharedUndoRoute();
    return route ? stepSharedUndo(route, "redo", message => { notices.show(message, "warn"); }) : undoOwner().redo();
  }
};
