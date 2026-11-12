import type { FormatMark } from "../text/runs.ts";
import type { StoredImageRef } from "../document/text-policy.ts";
import type { RowStatusId } from "../document/timing.ts";
import type { TagStatusId } from "../document/tags.ts";
import type { BrollStatusId } from "../document/broll.ts";

export type SharedContentRef = string & { readonly sharedContentRef: unique symbol };
export type SharedJsonValue = null | boolean | number | string | readonly SharedJsonValue[] | SharedJsonFields;
export interface SharedJsonFields { readonly [key: string]: SharedJsonValue }
export interface SharedTextAddress {
  readonly segment: SharedContentRef;
  readonly owner: SharedContentRef;
  readonly field: "audioText" | "visualText" | "heading" | "title";
}
export interface SharedIdentityGap {
  readonly left: SharedContentRef | null;
  readonly right: SharedContentRef | null;
  readonly affinity: "before" | "after";
}
export type SharedMarkValue =
  | { readonly kind: FormatMark | "dir" | "cue"; readonly value: true | null }
  | { readonly kind: "comment"; readonly id: SharedContentRef; readonly value: true | null }
  | { readonly kind: "tag"; readonly id: SharedContentRef; readonly value: SharedContentRef | null }
  | { readonly kind: "link"; readonly id: SharedContentRef; readonly value: string | null };
export type SharedInlineValue = string
  | { readonly atom: "broll"; readonly id: SharedContentRef; readonly text?: string }
  | { readonly atom: "who"; readonly name: string }
  | { readonly atom: "image"; readonly ref: StoredImageRef }
  | { readonly atom: "video"; readonly href: string; readonly host: string };
export interface SharedInsertionChunk {
  readonly value: SharedInlineValue;
  readonly marks: readonly SharedMarkValue[];
}
interface SharedOperationAuthor { readonly id: SharedContentRef; readonly by: string }
export interface SharedTextInsert extends SharedOperationAuthor {
  readonly kind: "text-insert";
  readonly target: SharedTextAddress;
  readonly at: SharedIdentityGap;
  readonly content: readonly SharedInsertionChunk[];
}
export interface SharedTextDelete extends SharedOperationAuthor {
  readonly kind: "text-delete";
  readonly target: SharedTextAddress;
  readonly observed: readonly SharedContentRef[];
}
export interface SharedMarkChange extends SharedOperationAuthor {
  readonly kind: "mark";
  readonly target: SharedTextAddress;
  readonly observed: readonly SharedContentRef[];
  readonly mark: SharedMarkValue;
}
export interface SharedSegmentCreate extends SharedOperationAuthor {
  readonly kind: "segment-create";
  readonly segment: SharedContentRef;
  readonly beat: SharedContentRef;
  readonly at: SharedIdentityGap;
  readonly fields: SharedJsonFields;
}
export interface SharedBeatSplit extends SharedOperationAuthor {
  readonly kind: "split";
  readonly target: SharedTextAddress;
  readonly at: SharedIdentityGap;
  readonly observed: readonly SharedContentRef[];
  readonly boundary: SharedContentRef;
  readonly beat: SharedContentRef;
  readonly fields: SharedJsonFields;
}
export type SharedBeatSplitBefore = Omit<SharedBeatSplit, "kind"> & { readonly kind: "split-before" };
export interface SharedBeatJoin extends SharedOperationAuthor {
  readonly kind: "join";
  readonly from: SharedContentRef;
  readonly into: SharedContentRef;
  readonly glue: " " | "";
}
export interface SharedJoinGlue extends SharedOperationAuthor {
  readonly kind: "join-glue";
  readonly joins: readonly SharedContentRef[];
  readonly glue: " " | "";
}
export interface SharedSoftRemove extends SharedOperationAuthor {
  readonly kind: "remove";
  readonly removalKind: "beat" | "range" | "header" | "became-heading";
  readonly comments?: readonly SharedContentRef[];
  readonly targets: readonly SharedContentRef[];
  readonly observed: readonly SharedContentRef[];
  readonly boundaries: readonly SharedContentRef[];
  readonly components: readonly SharedContentRef[];
  readonly gallery: readonly SharedContentRef[];
  readonly at: number;
}
export interface SharedRestore extends SharedOperationAuthor {
  readonly kind: "restore";
  readonly removals: readonly SharedContentRef[];
}
export interface SharedSegmentMove extends SharedOperationAuthor {
  readonly kind: "segment-move";
  readonly segments: readonly SharedContentRef[];
  readonly observedOrder: readonly SharedContentRef[];
  readonly at: SharedIdentityGap;
}
export interface SharedHeadingCreate extends SharedOperationAuthor {
  readonly kind: "heading-create";
  readonly segment: SharedContentRef;
  readonly heading: SharedContentRef;
  readonly firstBeat: SharedContentRef;
  readonly at: SharedIdentityGap;
}
export interface SharedHeadingFinalize extends SharedOperationAuthor {
  readonly kind: "heading-finalize";
  readonly target: SharedTextAddress;
  readonly heading: SharedContentRef;
  readonly prefix: readonly SharedContentRef[];
  readonly name: readonly SharedContentRef[];
  readonly separator: readonly SharedContentRef[];
  readonly tail: SharedIdentityGap;
  readonly retainedBeat: SharedContentRef | null;
  readonly emptyBeat: SharedContentRef | null;
}
export interface SharedHeadingRemove extends SharedOperationAuthor {
  readonly kind: "heading-remove";
  readonly heading: SharedContentRef;
  readonly observed: readonly SharedContentRef[];
  readonly newBeat: SharedContentRef | null;
  readonly nextBeat: SharedContentRef | null;
}
export type SharedRecordCollection = "comments" | "replies" | "people" | "tags" | "shots" | "gallery" | "visuals";
export interface SharedRecordAddress { readonly collection: SharedRecordCollection; readonly record: SharedContentRef }
export interface SharedRecordCreate extends SharedOperationAuthor {
  readonly kind: "record-create";
  readonly target: SharedRecordAddress;
  readonly fields: SharedJsonFields;
}
export type SharedFieldValue = { readonly value: SharedJsonValue; readonly clear?: false } | { readonly clear: true };
export type SharedRecordSet = SharedOperationAuthor & {
  readonly kind: "record-set";
  readonly target: SharedRecordAddress;
  readonly field: string;
} & SharedFieldValue;
export interface SharedRecordDelete extends SharedOperationAuthor {
  readonly kind: "record-delete";
  readonly target: SharedRecordAddress;
}
export interface SharedScalarAddress {
  readonly scope: "document" | "beat" | "heading";
  readonly record: SharedContentRef;
}
export type SharedScalarSet = SharedOperationAuthor & {
  readonly kind: "scalar";
  readonly target: SharedScalarAddress;
  readonly field: string;
} & SharedFieldValue;
export type SharedStatusEvent = SharedOperationAuthor & {
  readonly kind: "status";
  readonly parents: readonly SharedContentRef[];
  readonly prior?: SharedJsonValue;
} & (
  | { readonly target: { readonly scope: "beat"; readonly record: SharedContentRef }; readonly value: RowStatusId }
  | { readonly target: { readonly scope: "tag"; readonly record: SharedContentRef }; readonly value: TagStatusId }
  | { readonly target: { readonly scope: "shot"; readonly record: SharedContentRef }; readonly value: BrollStatusId }
);
export interface SharedRestoredUnit {
  readonly unit: SharedContentRef;
  readonly left: SharedContentRef | null;
  readonly value: SharedInlineValue;
  readonly marks: readonly SharedContentRef[];
}
export interface SharedTextRestore extends SharedOperationAuthor {
  readonly kind: "text-restore";
  readonly target: SharedTextAddress;
  readonly units: readonly SharedRestoredUnit[];
}
export interface SharedMarkRetract extends SharedOperationAuthor {
  readonly kind: "mark-retract";
  readonly target: SharedTextAddress;
  readonly occurrences: readonly SharedContentRef[];
}
export type SharedStatusRetire = SharedOperationAuthor & {
  readonly kind: "status-retire";
  readonly event: SharedContentRef;
} & Pick<SharedStatusEvent, "target" | "value">;
export type SharedOperation = SharedTextInsert | SharedTextDelete | SharedMarkChange | SharedSegmentCreate | SharedBeatSplitBefore
  | SharedBeatSplit | SharedBeatJoin | SharedJoinGlue | SharedSoftRemove | SharedRestore | SharedSegmentMove
  | SharedHeadingCreate | SharedHeadingFinalize | SharedHeadingRemove | SharedRecordCreate | SharedRecordSet
  | SharedRecordDelete | SharedScalarSet | SharedStatusEvent | SharedTextRestore | SharedMarkRetract | SharedStatusRetire;

export function replaceObservedText(
  deletion: SharedTextDelete, insertion: SharedTextInsert
): readonly [SharedTextInsert, SharedTextDelete] {
  // why: T01 composition retains the painted insertion gap only when insertion precedes observed deletion.
  return [insertion, deletion];
}
