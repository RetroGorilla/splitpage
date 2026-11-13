import type {
  SharedContentRef, SharedFieldValue, SharedInlineValue, SharedJsonFields, SharedMarkValue, SharedOperation,
  SharedRecordAddress, SharedScalarAddress, SharedStatusEvent, SharedTextAddress
} from "./operations.ts";

export interface SharedUndoUnit {
  readonly identity: SharedContentRef;
  readonly value: SharedInlineValue;
  readonly marks: readonly SharedMarkValue[];
}

export interface SharedUndoMarkOccurrence {
  readonly occurrence: SharedContentRef;
  readonly units: readonly SharedContentRef[];
}

export type SharedStructureCommand = Extract<SharedOperation["kind"],
  "segment-create" | "split" | "split-before" | "join" | "join-glue" | "join-retire" | "remove" | "restore" | "segment-move"
  | "heading-create" | "heading-finalize" | "heading-remove">;

export interface SharedUndoTextPart {
  readonly kind: "text";
  readonly target: SharedTextAddress;
  readonly inserted: readonly SharedContentRef[];
  readonly deleted: readonly SharedUndoUnit[];
}

export type SharedUndoPart =
  | SharedUndoTextPart
  | {
    readonly kind: "mark-add";
    readonly target: SharedTextAddress;
    readonly mark: SharedMarkValue;
    readonly added: readonly SharedUndoMarkOccurrence[];
    readonly spaces?: readonly string[];
  }
  | {
    readonly kind: "mark-remove";
    readonly target: SharedTextAddress;
    readonly mark: SharedMarkValue;
    readonly removed: readonly SharedUndoMarkOccurrence[];
    readonly spaces?: readonly string[];
  }
  | {
    readonly kind: "scalar";
    readonly target: SharedScalarAddress;
    readonly field: string;
    readonly prior: SharedFieldValue;
    readonly written: SharedFieldValue;
  }
  | {
    readonly kind: "status" | "status-retired";
    readonly target: SharedStatusEvent["target"];
    readonly event: SharedContentRef;
    readonly value: string;
  }
  | {
    readonly kind: "record-create" | "record-delete";
    readonly target: SharedRecordAddress;
    readonly fields: SharedJsonFields;
  }
  | {
    readonly kind: "record-field";
    readonly target: SharedRecordAddress;
    readonly field: string;
    readonly prior: SharedFieldValue;
    readonly written: SharedFieldValue;
  }
  | {
    readonly kind: "structure";
    readonly command: SharedStructureCommand;
    readonly operation: SharedContentRef;
  };

export interface SharedUndoSelection {
  readonly anchor: SharedContentRef;
  readonly focus: SharedContentRef;
}

export interface SharedUndoRecord {
  readonly label: string;
  readonly parts: readonly SharedUndoPart[];
  readonly selection: SharedUndoSelection | null;
  readonly typing: string | null;
}

export function sharedUndoPartName(part: SharedUndoPart): string {
  return part.kind === "structure" ? part.command : part.kind;
}

export function sharedUndoGroupKey(record: SharedUndoRecord): string | null {
  if (record.typing === null) return null;
  let key: string | null = null;
  for (const part of record.parts) {
    if (part.kind !== "text") return null;
    const own = JSON.stringify([part.target.owner, part.target.segment, part.target.field]);
    if (key !== null && key !== own) return null;
    key = own;
  }
  return key;
}

function sameTarget(a: SharedTextAddress, b: SharedTextAddress): boolean {
  return a.owner === b.owner && a.segment === b.segment && a.field === b.field;
}

export function mergeSharedUndoRecords(first: SharedUndoRecord, second: SharedUndoRecord): SharedUndoRecord | null {
  const parts: SharedUndoPart[] = [...first.parts];
  for (const part of second.parts) {
    if (part.kind !== "text") { parts.push(part); continue; }
    // why: a unit this group typed and then deleted was never in the script before the group; its undo restores nothing.
    const gone = new Set<string>();
    for (let index = 0; index < parts.length; index++) {
      const earlier = parts[index];
      if (!earlier || earlier.kind !== "text" || !sameTarget(earlier.target, part.target)) continue;
      const typed = new Set<string>(earlier.inserted);
      for (const unit of part.deleted) if (typed.has(unit.identity)) gone.add(unit.identity);
      if (earlier.inserted.some(identity => gone.has(identity))) {
        parts[index] = { ...earlier, inserted: earlier.inserted.filter(identity => !gone.has(identity)) };
      }
    }
    parts.push(gone.size ? { ...part, deleted: part.deleted.filter(unit => !gone.has(unit.identity)) } : part);
  }
  const kept = parts.filter(part => part.kind !== "text" || part.inserted.length > 0 || part.deleted.length > 0);
  return kept.length ? { label: first.label, parts: kept, selection: first.selection, typing: (first.typing ?? "") + (second.typing ?? "") } : null;
}
