import type { SharedSettledSelection, SharedStructureCommands } from "../../../application/commands/shared-structure.ts";
import { sharedBufferedTarget } from "../../../adapters/collab/buffer.ts";
import { holdSharedCapture } from "../../../adapters/collab/ingress.ts";
import { readSharedTextUnits } from "../../../adapters/collab/text-units.ts";
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
import { sharedStructurePorts, sharedValuePorts } from "./shared-values.ts";

const refuse = sharedCommandRefusalNotice(notices);
const SELECTION_SPANS = "split-selection-spans-beats", SELECTION_GONE = "split-selection-gone";

function refused(outcome: CommandOutcome): void {
  if (outcome.kind === "rejected" && !outcome.notified) refuse(outcome.reason);
}

function settle(): boolean {
  const refusal = sharedSessionParts()?.session.admit() ?? null;
  if (refusal?.kind === "failed") throw refusal.error;
  if (refusal) refused(refusal);
  return refusal === null;
}

function unitsOf(parts: SharedSessionParts, rowId: string): readonly string[] | null {
  try { return readSharedTextUnits(parts.handle, sharedBufferedTarget(parts.handle, bufferedFieldKey(rowId, "audioText"))); }
  catch { return null; }
}

function located(parts: SharedSessionParts, rowId: string, keys: readonly string[]): Map<string, { readonly rowId: string; readonly at: number }> {
  const found = new Map<string, { readonly rowId: string; readonly at: number }>();
  const rows = parts.session.read(doc => doc ? doc.rows.map(row => row.id) : []);
  for (const id of rows.includes(rowId) ? [rowId, ...rows.filter(id => id !== rowId)] : rows) {
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
    return { selected: units.slice(range.from, range.to), after: units[range.from], before: units[range.from - 1] };
  } finally { release(); }
}

function settleSelection(rowId: string, read: SelectionRead): SharedSettledSelection | null {
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
  if (!first || places.some(place => place.rowId !== first.rowId)) { refuse(first ? SELECTION_SPANS : SELECTION_GONE); return null; }
  const offsets = places.map(place => place.at).sort((a, b) => a - b);
  return { rowId: first.rowId, removed: runs(offsets), at: offsets[0] as number };
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
