import type {
  SharedContentRef, SharedFieldValue, SharedJsonFields, SharedJsonValue, SharedMarkValue, SharedOperation, SharedRecordAddress, SharedRecordCollection, SharedStatusEvent,
  SharedTextAddress
} from "../../core/collab/operations.ts";
import type { SharedUndoMarkOccurrence, SharedUndoPart, SharedUndoRecord, SharedUndoSelection, SharedUndoUnit } from "../../core/collab/undo-record.ts";
import { sharedUndoPartName } from "../../core/collab/undo-record.ts";
import type { SharedUndoReversal } from "../../application/editing/undo/shared-undo.ts";
import { readOperation } from "../../core/collab/read-operation.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedBaseExecutionResult } from "./execute.ts";
import type { SharedMarkGroup } from "./mark-record.ts";
import type { SharedHistoryUnit, SharedTextHistory } from "./text-history.ts";
import { executeSharedOperations } from "./execute.ts";
import { collabState, sharedWriteFrame } from "./state.ts";
import { scalarTarget } from "./scalar-executor.ts";
import { sharedStampOperation } from "./stamp.ts";
import { readSharedStatus, readSharedStatusHeads } from "./status.ts";
import { readSharedAnchorUnit } from "./anchors.ts";
import { sharedPreparedValue } from "./prepare-value.ts";
import { readSharedTextHistory, readSharedVisibleUnits } from "./text-history.ts";
import { readSharedRecords } from "./record-reader.ts";
import { readSharedTextRestoreOperation } from "./mark-provenance.ts";
import { createSharedPreparation } from "./prepare.ts";
import { SharedTextPreparationError } from "./executor-text-plan.ts";
import { readSharedJoinedText, usesSharedJoinedText } from "./joined-text-routing.ts";
import { readSharedJoinedTextGeometry } from "./joined-text-geometry.ts";
import { sharedStructureReference } from "./structure-identity.ts";
import { sharedJoinGlueReference } from "./join-glue-reference.ts";
import { sharedJoinFormatRegisterField } from "../../core/collab/projection/join-glue.ts";
import { FORMAT_MARKS } from "../../core/text/runs.ts";
import type { FormatMark } from "../../core/text/runs.ts";
import { sharedJoinRetirementGroup } from "./join-record.ts";
import { hasLaterSharedJoin, isSharedJoinRetired, nextSharedJoinGeneration, planSharedJoinGlueUndo, readSharedJoinBeforeRetire, readSharedJoinNeighbours, readSharedJoinOf,
  readSharedJoinPlace, readSharedJoinSeparator, recordSharedJoin } from "./undo-join.ts";
import type { SharedJoinUndoPart } from "./undo-join.ts";
import { planSharedSplitUndo, recordSharedSplit } from "./undo-split.ts";
import { planSharedRemovalUndo, readSharedLiveStructure, recordSharedRemoval } from "./undo-removal.ts";

export const SHARED_UNDO_PARTS: readonly string[] = Object.freeze(["text", "mark-add", "mark-remove", "scalar", "status", "status-retired",
  "record-create", "record-delete", "record-field", "join", "remove", "restore", "discard", "discard-retired", "join-glue", "beat-split"]);
export const SHARED_UNDO_RECORDS: readonly SharedRecordCollection[] = Object.freeze(["comments", "replies", "people", "tags", "shots"] as const);

export interface SharedUndoWriter { readonly by: string; readonly nextId: () => string }
export interface SharedCommandDescription { readonly label: string; readonly selection: SharedUndoSelection | null; readonly typing: string | null }
export interface SharedCommandExecution { readonly result: SharedBaseExecutionResult; readonly record: SharedUndoRecord | null }

type Planned = { readonly inverse: (after: (target: SharedTextAddress) => SharedTextHistory | null) => { readonly effective: boolean; readonly part: SharedUndoPart } };
class SharedUndoRefusal extends Error {}

export function supportsSharedUndoPart(part: string): boolean { return SHARED_UNDO_PARTS.includes(part); }

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function eventKey(handle: SharedDocumentHandle, id: string): SharedContentRef { return JSON.stringify([String(collabState(handle).doc.clientID), id]) as SharedContentRef; }
function namedBy(operation: string, name: string, id: string): boolean { return operation.startsWith(JSON.stringify([name, id]).slice(0, -1) + ","); }

function shows(unit: SharedHistoryUnit, mark: SharedMarkValue): boolean {
  return unit.marks.some(group => group.kind === mark.kind && (!("id" in mark) || group.values.includes(mark.id)));
}

function markValues(groups: readonly SharedMarkGroup[]): SharedMarkValue[] {
  const marks: SharedMarkValue[] = [];
  for (const group of groups) for (const value of group.values) {
    if (group.kind === "comment") marks.push({ kind: "comment", id: value as SharedContentRef, value: true });
    else if (group.kind === "tag") marks.push({ kind: "tag", id: value as SharedContentRef, value: value as SharedContentRef });
    else if (group.kind === "link") marks.push({ kind: "link", id: value as SharedContentRef, value: String(value) });
    else marks.push({ kind: group.kind, value: true });
  }
  return marks.filter((mark, index) => marks.findIndex(other => same(other, mark)) === index);
}

function added(mark: SharedMarkValue): SharedMarkValue {
  return mark.kind === "comment" ? { ...mark, value: true } : mark.kind === "tag" ? { ...mark, value: mark.id } : mark.kind === "link" ? { ...mark, value: mark.id } : { ...mark, value: true };
}

function undoUnits(units: readonly SharedHistoryUnit[]): SharedUndoUnit[] {
  const result: SharedUndoUnit[] = [];
  let first: SharedHistoryUnit | null = null;
  for (const unit of units) {
    const last = result.at(-1), value = unit.value;
    // why: the two halves of one character outside the basic plane are deleted and restored together.
    if (last && first && typeof value === "string" && typeof last.value === "string" && /^[\ud800-\udbff]$/.test(last.value) && /^[\udc00-\udfff]$/.test(value)
      && first.unit.client === unit.unit.client && first.unit.clock + 1 === unit.unit.clock) {
      result[result.length - 1] = { ...last, value: last.value + value };
    } else result.push({ identity: unit.identity, value, marks: markValues(unit.marks) });
    first = unit;
  }
  return result;
}

function occurrencesOf(history: SharedTextHistory, operation: string): SharedUndoMarkOccurrence[] {
  return history.records.filter(item => item.record.type === "add" && namedBy(item.record.operation, "range-mark", operation))
    .map(item => ({ occurrence: item.identity, units: history.showing(item.identity).map(unit => unit.identity) }));
}

function formatOf(mark: SharedMarkValue): FormatMark | null { return FORMAT_MARKS.find(kind => kind === mark.kind) ?? null; }
function spaceFormat(handle: SharedDocumentHandle, group: string, format: FormatMark): boolean {
  return collabState(handle).roots.meta.get(sharedJoinFormatRegisterField(group, format)) === true;
}

// why: a joined row keeps each piece's marks in its own text, and each space's format beside its join.
function joinedRow(handle: SharedDocumentHandle, recorded: SharedTextAddress, rooted = false):
  { readonly target: SharedTextAddress; readonly pieces: SharedTextAddress[]; readonly groups: string[] } | null {
  const prep = createSharedPreparation(handle);
  try {
    const owner = rooted ? prep.view.resolveOwner(sharedStructureReference(prep.view, recorded.owner), "audioText") : null;
    const geometry = owner ? readSharedJoinedTextGeometry(prep.view, owner.owner) : null, root = geometry?.root as SharedContentRef | undefined;
    // why: a row joined into an earlier row since the command is read, and its spaces written, through that row.
    const target = root && root !== owner?.owner ? { ...recorded, owner: root, segment: root } : recorded;
    if (!usesSharedJoinedText(prep.view, target)) return null;
    const row = readSharedJoinedText(prep.view, target), pieces = new Map<string, SharedTextAddress>();
    if (!row) return null;
    for (const span of row.spans) if (!pieces.has(span.plan.path.join("\0"))) pieces.set(span.plan.path.join("\0"), { ...span.plan.target, owner: span.owner as SharedContentRef });
    return { target, pieces: [...pieces.values()], groups: row.items.flatMap(item => item.group ? [item.group] : []) };
  } catch (error) {
    if (error instanceof SharedTextPreparationError) return null;
    throw error;
  } finally { prep.close(); }
}

// why: a space is changed back only while its join is still in the row and it holds what the command wrote.
function spacesToReverse(handle: SharedDocumentHandle, part: { readonly target: SharedTextAddress; readonly mark: SharedMarkValue; readonly spaces?: readonly string[] },
  written: boolean): { readonly target: SharedTextAddress; readonly spaces: string[] } {
  const format = formatOf(part.mark), row = part.spaces?.length && format ? joinedRow(handle, part.target, true) : null;
  return { target: row?.target ?? part.target,
    spaces: row && format ? (part.spaces ?? []).filter(group => row.groups.includes(group) && spaceFormat(handle, group, format) === written) : [] };
}

function spaceMark(target: SharedTextAddress, spaces: readonly string[], mark: SharedMarkValue, author: { id: string; by: string }): Record<string, unknown> {
  return { kind: "mark", ...author, target, observed: spaces.map(group => sharedJoinGlueReference(group)), mark };
}


function operationOf(raw: Record<string, unknown>): SharedOperation {
  const operation = readOperation(raw);
  if (!operation) throw new SharedUndoRefusal("invalid-operation");
  return operation;
}

function historyOf(handle: SharedDocumentHandle, target: SharedTextAddress): SharedTextHistory {
  const history = readSharedTextHistory(handle, target);
  if (!history) throw new SharedUndoRefusal("missing-target");
  return history;
}

function fieldNow(handle: SharedDocumentHandle, part: Extract<SharedUndoPart, { kind: "scalar" }>): SharedFieldValue {
  const record = scalarTarget(handle, part.target);
  if (!record) throw new SharedUndoRefusal("missing-target");
  return record.has(part.field) ? { value: sharedPreparedValue(record.get(part.field)) as Extract<SharedFieldValue, { clear?: false }>["value"] } : { clear: true };
}

function recordFields(handle: SharedDocumentHandle, target: SharedRecordAddress): SharedJsonFields | null {
  const found = readSharedRecords(handle, target.collection).find(item => item.key === target.record);
  if (!found) return null;
  const fields: Record<string, SharedJsonValue> = { ...sharedPreparedValue(found.fields) as SharedJsonFields };
  const scope = target.collection === "tags" ? "tag" : target.collection === "shots" ? "shot" : null;
  // why: a status is set by events beside the fields, so the status the record shows is read with them.
  if (scope) fields.status = readSharedStatus(handle, { scope, record: target.record as SharedContentRef } as SharedStatusEvent["target"]);
  // why: props and links are read with their rank and written without it; a record is kept in the form a command writes.
  for (const nested of ["props", "links"] as const) {
    const entries = fields[nested];
    if (Array.isArray(entries)) fields[nested] = entries.map(entry => {
      const read = (entry as { readonly fields: SharedJsonFields }).fields;
      return Object.fromEntries(Object.entries(read).filter(([field]) => field !== "rank" && field !== "extra"));
    });
  }
  return fields;
}

function recordNow(handle: SharedDocumentHandle, part: { readonly kind: string; readonly target: SharedRecordAddress }): SharedJsonFields | null {
  // why: a visual and a picture's creation or removal are parts of a beat; their undo comes with the structure commands.
  if (!SHARED_UNDO_RECORDS.includes(part.target.collection) && !(part.target.collection === "gallery" && part.kind === "record-field")) {
    throw new SharedUndoRefusal("undo-unsupported:" + part.kind + ":" + part.target.collection);
  }
  return recordFields(handle, part.target);
}

function recordField(fields: SharedJsonFields, field: string): SharedFieldValue {
  const value = fields[field];
  return value === undefined ? { clear: true } : { value };
}

function planPart(handle: SharedDocumentHandle, part: SharedUndoPart, writer: SharedUndoWriter, operations: SharedOperation[]): Planned {
  const author = (): { id: string; by: string } => ({ id: writer.nextId(), by: writer.by });
  switch (part.kind) {
    case "text": {
      const history = historyOf(handle, part.target), removed: SharedHistoryUnit[] = [];
      for (const identity of part.inserted) {
        const unit = readSharedAnchorUnit(identity), live = unit && history.live(history.follow(unit));
        if (live && !removed.includes(live)) removed.push(live);
      }
      const restores = part.deleted.flatMap(unit => {
        const original = readSharedAnchorUnit(unit.identity);
        if (!original || original.after || !history.known(original) || history.live(original) || history.back(original)) return [];
        return [{ original, unit: unit.identity, left: history.left(original)?.identity ?? null, value: unit.value, marks: history.shown(original) }];
      }).sort((a, b) => history.order(a.original) - history.order(b.original));
      const restore = restores.length ? author() : null;
      // why: a restored character is placed after a visible neighbour, so it is written before this undo deletes any.
      if (restore) operations.push(operationOf({ kind: "text-restore", ...restore, target: history.target, units: restores.map(({ unit, left, value, marks }) => ({ unit, left, value, marks })) }));
      if (removed.length) operations.push(operationOf({ kind: "text-delete", ...author(), target: history.target, observed: removed.map(unit => unit.identity) }));
      return { inverse: after => {
        const now = after(part.target), inserted = restore && now ? now.records.flatMap(item => {
          if (item.record.type !== "birth" || !namedBy(item.record.operation, "text-restore", restore.id) || !readSharedTextRestoreOperation(item.record.operation)) return [];
          // why: one restored value can be two units; the inverse names every unit the restore wrote.
          const { client, clock, length } = item.record.born;
          return Array.from({ length }, (_, unit) => now.live({ client, clock: clock + unit })).filter(unit => unit !== null);
        }).sort((a, b) => a.index - b.index).map(unit => unit.identity) : [];
        removed.sort((a, b) => a.index - b.index);
        return { effective: removed.length + inserted.length > 0, part: { kind: "text", target: part.target, inserted, deleted: undoUnits(removed) } };
      } };
    }
    case "mark-add": {
      const history = historyOf(handle, part.target);
      const removed = part.added.map(entry => ({ occurrence: entry.occurrence, units: history.showing(entry.occurrence).map(unit => unit.identity) })).filter(entry => entry.units.length);
      if (removed.length) operations.push(operationOf({ kind: "mark-retract", ...author(), target: history.target, occurrences: removed.map(entry => entry.occurrence) }));
      const { target, spaces } = spacesToReverse(handle, part, true);
      if (spaces.length) operations.push(operationOf(spaceMark(target, spaces, { ...added(part.mark), value: null }, author())));
      return { inverse: () => ({ effective: removed.length + spaces.length > 0,
        part: { kind: "mark-remove", target: part.target, mark: part.mark, removed, ...spaces.length ? { spaces } : {} } }) };
    }
    case "mark-remove": {
      const history = historyOf(handle, part.target), mark = added(part.mark), wanted: SharedHistoryUnit[] = [];
      for (const identity of part.removed.flatMap(entry => entry.units)) {
        const unit = readSharedAnchorUnit(identity), live = unit && history.live(history.follow(unit));
        // why: putting a mark back touches only the recorded characters that do not show it; the rest is other people's.
        if (live && !shows(live, mark) && !wanted.includes(live)) wanted.push(live);
      }
      const command = wanted.length ? author() : null;
      if (command) operations.push(operationOf({ kind: "mark", ...command, target: history.target, observed: wanted.map(unit => unit.identity), mark }));
      const { target, spaces } = spacesToReverse(handle, part, false);
      if (spaces.length) operations.push(operationOf(spaceMark(target, spaces, mark, author())));
      return { inverse: after => {
        const now = command && after(part.target);
        return { effective: wanted.length + spaces.length > 0, part: { kind: "mark-add", target: part.target, mark: part.mark,
          added: now && command ? occurrencesOf(now, command.id) : [], ...spaces.length ? { spaces } : {} } };
      } };
    }
    case "scalar": {
      const effective = same(fieldNow(handle, part), part.written);
      // why: the earlier value is written only while the field still holds what the command wrote.
      if (effective) operations.push(operationOf({ kind: "scalar", ...author(), target: part.target, field: part.field, ...part.prior }));
      return { inverse: () => ({ effective, part: { ...part, prior: part.written, written: part.prior } }) };
    }
    case "status": {
      const before = readSharedStatus(handle, part.target);
      operations.push(operationOf({ kind: "status-retire", ...author(), target: part.target, event: part.event, value: part.value }));
      return { inverse: () => ({ effective: readSharedStatus(handle, part.target) !== before, part: { ...part, kind: "status-retired" } }) };
    }
    case "status-retired": {
      const command = readSharedStatus(handle, part.target) === part.value ? null : author();
      if (command) operations.push(operationOf({ kind: "status", ...command, target: part.target, value: part.value, parents: readSharedStatusHeads(handle, part.target) }));
      return { inverse: () => ({ effective: command !== null, part: { kind: "status", target: part.target, event: command ? eventKey(handle, command.id) : part.event, value: part.value } }) };
    }
    case "record-create": {
      const now = recordNow(handle, part), effective = now !== null && same(now, part.fields);
      // why: undoing a creation removes the record only while it still holds what the creation wrote.
      if (effective) operations.push(operationOf({ kind: "record-delete", ...author(), target: part.target }));
      return { inverse: () => ({ effective, part: { ...part, kind: "record-delete" } }) };
    }
    case "record-delete": {
      const effective = recordNow(handle, part) === null, wrote = part.fields.author;
      // why: a comment or reply keeps its author, so it is put back in that person's name.
      const by = (part.target.collection === "comments" || part.target.collection === "replies") && typeof wrote === "string" ? wrote : writer.by;
      if (effective) operations.push(operationOf({ kind: "record-create", id: writer.nextId(), by, target: part.target, fields: part.fields }));
      return { inverse: () => ({ effective, part: { ...part, kind: "record-create" } }) };
    }
    case "record-field": {
      const now = recordNow(handle, part), effective = now !== null && same(recordField(now, part.field), part.written);
      if (effective) operations.push(operationOf({ kind: "record-set", ...author(), target: part.target, field: part.field, ...part.prior }));
      return { inverse: () => ({ effective, part: { ...part, prior: part.written, written: part.prior } }) };
    }
    case "join": return planJoin(handle, part, author, operations);
    case "beat-split": {
      const plan = planSharedSplitUndo(handle, part, author, raw => { operations.push(operationOf(raw)); });
      return { inverse: () => ({ effective: plan.effective, part: plan.inverse() }) };
    }
    case "join-glue": {
      const effective = planSharedJoinGlueUndo(handle, part, glue => { operations.push(operationOf({ kind: "join-glue", ...author(), joins: [part.join], glue })); });
      return { inverse: () => ({ effective, part: { ...part, prior: part.written, written: part.prior } }) };
    }
    case "remove": case "restore": {
      const plan = planSharedRemovalUndo(handle, part, author, raw => { const operation = operationOf(raw); operations.push(operation); return operation; });
      return { inverse: () => ({ effective: plan.effective, part: plan.inverse() }) };
    }
    case "discard": {
      const { discards, retiredDiscards } = collabState(handle).roots, effective = discards.has(part.discard) && !retiredDiscards.has(part.discard);
      if (effective) operations.push(operationOf({ kind: "discard-retire", ...author(), discard: part.discard }));
      return { inverse: () => ({ effective, part: { ...part, kind: "discard-retired" } }) };
    }
    case "discard-retired": {
      const command = author();
      operations.push(operationOf({ kind: "discard", ...command, entry: part.entry, removals: part.removals }));
      return { inverse: () => ({ effective: true, part: { ...part, kind: "discard", discard: eventKey(handle, command.id) } }) };
    }
    default: throw new SharedUndoRefusal("undo-unsupported:" + sharedUndoPartName(part));
  }
}

function planJoin(handle: SharedDocumentHandle, part: SharedJoinUndoPart, author: () => { id: string; by: string }, operations: SharedOperation[]): Planned {
  const place = readSharedJoinPlace(handle, part.from, part.into), group = sharedJoinRetirementGroup(part.from, part);
  if (!part.retired) {
    const effective = !place.removed && place.joined !== null && !isSharedJoinRetired(handle, part.join, group) && !hasLaterSharedJoin(handle, part);
    const formats = effective ? FORMAT_MARKS.filter(format => spaceFormat(handle, group, format)) : [];
    if (effective) operations.push(operationOf({ kind: "join-retire", ...author(), joins: [part.join] }));
    return { inverse: () => ({ effective, part: { ...part, retired: true, glue: place.joined?.glue ?? part.glue, ...formats.length ? { formats } : {} } }) };
  }
  // why: the same two beats joined again meanwhile are someone else's change, so the redo is used up; removed beats
  // are not in the order the neighbour check walks, so a removed source or target uses it up too.
  const join = !place.joined && readSharedJoinNeighbours(handle, part.from, part.into) ? author() : null;
  if (join) {
    const generation = nextSharedJoinGeneration(handle, part.from, part.into, part.glue), target = { owner: place.root, segment: place.root, field: "audioText" } as SharedTextAddress;
    const space = sharedJoinRetirementGroup(part.from, { into: part.into, glue: part.glue, generation });
    operations.push(operationOf({ kind: "join", ...join, from: part.from, into: part.into, glue: part.glue }));
    for (const format of part.formats ?? []) operations.push(operationOf(spaceMark(target, [space], { kind: format, value: true }, author())));
  }
  return { inverse: () => ({ effective: join !== null, part: join && readSharedJoinOf(handle, part.from, join.id) || part }) };
}

// why: a record holds only what its own command wrote, so it is read before the updates held meanwhile are applied.
function beforeHeldUpdates<T>(handle: SharedDocumentHandle, run: () => T): T { return sharedWriteFrame(collabState(handle), run); }

export function reverseSharedUndoRecord(handle: SharedDocumentHandle, record: SharedUndoRecord, writer: SharedUndoWriter): SharedUndoReversal {
  return beforeHeldUpdates(handle, () => reverseRecord(handle, record, writer));
}

function reverseRecord(handle: SharedDocumentHandle, record: SharedUndoRecord, writer: SharedUndoWriter): SharedUndoReversal {
  const operations: SharedOperation[] = [], planned: Planned[] = [], merged: SharedUndoPart[] = [];
  for (const part of record.parts) {
    const last = merged.at(-1);
    // why: keystrokes of one typing entry in one text are restored together, so they keep their order.
    if (part.kind === "text" && last?.kind === "text" && same(last.target, part.target)) {
      merged[merged.length - 1] = { ...last, inserted: [...last.inserted, ...part.inserted], deleted: [...last.deleted, ...part.deleted] };
    } else merged.push(part);
  }
  try {
    for (const part of merged.reverse()) planned.unshift(planPart(handle, part, writer, operations));
  } catch (error) {
    if (error instanceof SharedUndoRefusal) return { ok: false, reason: error.message };
    throw error;
  }
  if (operations.length) {
    const result = executeSharedOperations(handle, operations, { origin: "local-undo" });
    if (!result.ok) return { ok: false, reason: result.reason };
  }
  const histories = new Map<string, SharedTextHistory | null>();
  const after = (target: SharedTextAddress): SharedTextHistory | null => {
    const key = JSON.stringify([target.owner, target.segment, target.field]);
    if (!histories.has(key)) histories.set(key, readSharedTextHistory(handle, target));
    return histories.get(key) ?? null;
  };
  const parts = planned.map(plan => plan.inverse(after));
  return { ok: true, effective: parts.some(part => part.effective), selection: record.selection,
    inverse: { label: record.label, parts: parts.map(part => part.part), selection: record.selection, typing: null } };
}

function statusKinds(operation: SharedOperation): operation is SharedStatusEvent { return operation.kind === "status"; }

export function executeSharedCommand(handle: SharedDocumentHandle, operations: readonly SharedOperation[], description: SharedCommandDescription,
  options: { readonly base?: number } = {}): SharedCommandExecution {
  return beforeHeldUpdates(handle, () => executeCommand(handle, operations, description, options));
}

function executeCommand(handle: SharedDocumentHandle, operations: readonly SharedOperation[], description: SharedCommandDescription,
  options: { readonly base?: number }): SharedCommandExecution {
  const before = new Map<string, SharedTextHistory | null>(), priors = new Map<SharedOperation, SharedFieldValue>(), typed = new Map<string, ReadonlySet<string>>();
  const textKey = (target: SharedTextAddress): string => JSON.stringify([target.owner, target.segment, target.field]);
  const records = new Map<string, SharedJsonFields | null>(), recorded = new Set<string>();
  const recordKey = (target: SharedRecordAddress): string => JSON.stringify([target.collection, target.record]);
  const inserts = new Set(operations.flatMap(operation => operation.kind === "text-insert" ? [textKey(operation.target)] : []));
  const scopes = new Map<SharedOperation, { readonly pieces: readonly SharedTextAddress[]; readonly spaces: ReadonlyMap<string, boolean> }>();
  for (const operation of operations) if (operation.kind === "mark") {
    const row = joinedRow(handle, operation.target), format = formatOf(operation.mark);
    scopes.set(operation, { pieces: row?.pieces ?? [operation.target], spaces: new Map(row && format ? row.groups.map(group => [group, spaceFormat(handle, group, format)]) : []) });
  }
  for (const operation of operations) if (operation.kind === "text-delete" || operation.kind === "mark") inserts.delete(textKey(operation.target));
  for (const scope of scopes.values()) for (const piece of scope.pieces) inserts.delete(textKey(piece));
  for (const operation of operations) {
    if (operation.kind === "mark") {
      for (const piece of scopes.get(operation)?.pieces ?? []) {
        const key = textKey(piece);
        if (!typed.has(key) && !before.has(key)) before.set(key, readSharedTextHistory(handle, piece));
      }
    } else if (operation.kind === "text-insert" || operation.kind === "text-delete") {
      const key = textKey(operation.target), visible = inserts.has(key) && !typed.has(key) ? readSharedVisibleUnits(handle, operation.target) : null;
      if (visible) typed.set(key, visible);
      else if (!typed.has(key) && !before.has(key)) before.set(key, readSharedTextHistory(handle, operation.target));
    } else if (operation.kind === "record-create" || operation.kind === "record-set" || operation.kind === "record-delete") {
      if (!records.has(recordKey(operation.target))) records.set(recordKey(operation.target), recordFields(handle, operation.target));
    } else if (operation.kind === "scalar" && !sharedStampOperation(operation)) {
      // why: assumed rule 35 on #1414: a stamp is left out of the undo record, so stamped typing still groups.
      const record = scalarTarget(handle, operation.target);
      if (record) priors.set(operation, record.has(operation.field) ? { value: sharedPreparedValue(record.get(operation.field)) as Extract<SharedFieldValue, { clear?: false }>["value"] } : { clear: true });
    }
  }
  const removals = operations.filter(operation => operation.kind === "remove" || operation.kind === "restore" || operation.kind === "heading-remove");
  const unjoins = new Map(operations.flatMap(operation => operation.kind === "join-retire" ? [[operation, operation.joins.map(join => readSharedJoinBeforeRetire(handle, join))] as const] : []));
  const glues = new Map(operations.flatMap(operation => operation.kind === "join-glue"
    ? [[operation, operation.joins.map(join => { const found = readSharedJoinSeparator(handle, join); return found && { join, ...found }; })] as const] : []));
  // why: which beats a removal or a restore took away or brought back is read from the live beats around it.
  const live = removals.length === 1 ? readSharedLiveStructure(handle) : null;
  const result = executeSharedOperations(handle, operations, options);
  if (!result.ok) return { result, record: null };
  const parts: SharedUndoPart[] = [], described = new Set<string>(), spaced = new Set<string>(), after = new Map<string, SharedTextHistory | null>();
  const unjoined = new Set<string>();
  const now = (target: SharedTextAddress): SharedTextHistory | null => {
    if (!after.has(textKey(target))) after.set(textKey(target), readSharedTextHistory(handle, target));
    return after.get(textKey(target)) ?? null;
  };
  for (const operation of operations) {
    if (operation.kind === "text-insert" || operation.kind === "text-delete") {
      const key = textKey(operation.target), was = before.get(key), visible = typed.get(key);
      if (described.has(key) || !was && !visible) continue;
      const is = now(operation.target);
      if (!is) continue;
      described.add(key);
      const inserted = is.units.filter(unit => was ? !was.live(unit.unit) : !visible?.has(unit.unit.client + ":" + unit.unit.clock)).map(unit => unit.identity);
      const deleted = was ? undoUnits(was.units.filter(unit => !is.live(unit.unit))) : [];
      if (inserted.length || deleted.length) parts.push({ kind: "text", target: operation.target, inserted, deleted });
    } else if (operation.kind === "mark") {
      const scope = scopes.get(operation);
      for (const piece of scope?.pieces ?? []) {
        const was = before.get(textKey(piece)), is = now(piece);
        if (!was || !is) continue;
        if (operation.mark.value !== null) {
          const occurrences = occurrencesOf(is, operation.id);
          if (occurrences.length) parts.push({ kind: "mark-add", target: piece, mark: operation.mark, added: occurrences });
          continue;
        }
        const observed = [...new Set(is.records.filter(item => item.record.type === "remove" && namedBy(item.record.operation, "range-mark", operation.id))
          .flatMap(item => item.record.type === "remove" ? item.record.observed : []))];
        const removed = observed.map(occurrence => ({ occurrence, units: was.showing(occurrence).filter(unit => !is.showing(occurrence).some(other => other.identity === unit.identity))
          .map(unit => unit.identity) })).filter(entry => entry.units.length);
        if (removed.length) parts.push({ kind: "mark-remove", target: piece, mark: operation.mark, removed });
      }
      const format = formatOf(operation.mark), spaces = format ? [...scope?.spaces ?? []].filter(([group, prior]) => {
        const field = sharedJoinFormatRegisterField(group, format), changed = !spaced.has(field) && prior !== spaceFormat(handle, group, format);
        spaced.add(field);
        return changed;
      }).map(([group]) => group) : [];
      // why: the spaces of a row are addressed through the row, so they get a part of their own with the command's target.
      if (spaces.length) parts.push(operation.mark.value === null ? { kind: "mark-remove", target: operation.target, mark: operation.mark, removed: [], spaces }
        : { kind: "mark-add", target: operation.target, mark: operation.mark, added: [], spaces });
    } else if (operation.kind === "scalar") {
      const prior = priors.get(operation), record = scalarTarget(handle, operation.target);
      const written: SharedFieldValue | null = !record ? null : record.has(operation.field)
        ? { value: sharedPreparedValue(record.get(operation.field)) as Extract<SharedFieldValue, { clear?: false }>["value"] } : { clear: true };
      if (prior && written && !same(prior, written)) parts.push({ kind: "scalar", target: operation.target, field: operation.field, prior, written });
    } else if (statusKinds(operation)) {
      parts.push({ kind: "status", target: operation.target, event: eventKey(handle, operation.id), value: operation.value });
    } else if (operation.kind === "record-create" || operation.kind === "record-set" || operation.kind === "record-delete") {
      const key = recordKey(operation.target), was = records.get(key) ?? null, is = recordFields(handle, operation.target);
      if (recorded.has(key)) continue;
      recorded.add(key);
      // why: one record is described once per command, by what it was before and what it is after.
      if (!was && is) parts.push({ kind: "record-create", target: operation.target, fields: is });
      else if (was && !is) parts.push({ kind: "record-delete", target: operation.target, fields: was });
      else if (was && is) for (const field of [...new Set([...Object.keys(was), ...Object.keys(is)])].sort()) {
        // why: a status changes through its own operation and is undone by the status part.
        if (field === "status" && (operation.target.collection === "tags" || operation.target.collection === "shots")) continue;
        // why: assumed rule 35 on #1414: a comment's updatedAt and resolution are stamps, left out like a beat stamp.
        if (operation.target.collection === "comments" && (field === "updatedAt" || field === "resolution")) continue;
        const prior = recordField(was, field), written = recordField(is, field);
        if (!same(prior, written)) parts.push({ kind: "record-field", target: operation.target, field, prior, written });
      }
    } else if ((operation.kind === "remove" || operation.kind === "restore" || operation.kind === "heading-remove" && operation.newBeat === null) && live) {
      parts.push(recordSharedRemoval(handle, operation, live) ?? { kind: "structure", command: operation.kind, operation: operation.id });
    } else if (operation.kind === "split" || operation.kind === "split-before") {
      parts.push(recordSharedSplit(handle, operation) ?? { kind: "structure", command: operation.kind, operation: operation.id });
    } else if (operation.kind === "join-retire") {
      for (const part of unjoins.get(operation) ?? []) if (part && !unjoined.has(part.join)) { unjoined.add(part.join); parts.push(part); }
    } else if (operation.kind === "join-glue") {
      const seen = glues.get(operation) ?? [];
      // why: a separator set on a join made in the same command has no earlier value, so the command stays refused.
      if (seen.some(item => !item)) { parts.push({ kind: "structure", command: operation.kind, operation: operation.id }); continue; }
      for (const item of seen) {
        const now = item && readSharedJoinSeparator(handle, item.join);
        if (item && now && now.separator !== item.separator) parts.push({ kind: "join-glue", join: item.join as SharedContentRef, from: item.from as SharedContentRef, prior: item.separator, written: now.separator });
      }
    } else if (operation.kind === "join") {
      parts.push(recordSharedJoin(handle, operation) ?? { kind: "structure", command: operation.kind, operation: operation.id });
    } else if (operation.kind === "discard") {
      parts.push({ kind: "discard", discard: eventKey(handle, operation.id), entry: operation.entry, removals: operation.removals });
    } else if (operation.kind !== "text-restore" && operation.kind !== "mark-retract" && operation.kind !== "status-retire" && operation.kind !== "discard-retire"
      && operation.kind !== "split-retire" && operation.kind !== "split-restore") {
      parts.push({ kind: "structure", command: operation.kind, operation: operation.id });
    }
  }
  return { result, record: parts.length ? { label: description.label, parts, selection: description.selection, typing: description.typing } : null };
}
