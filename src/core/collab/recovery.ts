import type { SharedProjectionFragmentReason } from "./projection/blocks.ts";
import type { SharedProjectionGalleryOverflow } from "./projection/gallery.ts";
import type { SharedTagProjectionRejection } from "./projection/tag-extents.ts";
import type { SharedProjectionUnit } from "./projection/units.ts";
import type { SharedRemovalBufferSource } from "./removal-state.ts";

export interface SharedRecoveryRemoval {
  readonly ids: readonly string[];
  readonly by: string;
  readonly edited: readonly { readonly client: number; readonly clock: number }[];
}

export interface SharedRecoveryRemovalSource { readonly key: string; readonly by: string; readonly observed: ReadonlySet<string> }

export type SharedRecoveryEntry =
  | (SharedTagProjectionRejection & { readonly rowId: string; readonly field: "audioText" | "visualText" })
  | (SharedProjectionGalleryOverflow & { readonly kind: "gallery-overflow"; readonly rowId: string })
  | { readonly kind: "removed-beat"; readonly row: Readonly<Record<string, unknown>>; readonly members: readonly string[]; readonly removal?: SharedRecoveryRemoval;
    readonly buffer?: readonly SharedRemovalBufferSource[]; readonly splitBy?: string; readonly comments?: readonly string[] }
  | { readonly kind: "comment-without-words"; readonly comment: string; readonly rowId: string | null; readonly field: string | null }
  | { readonly kind: "reply-without-comment"; readonly reply: string; readonly commentId: string }
  | { readonly kind: "unprojectable-fragment"; readonly reason: SharedProjectionFragmentReason; readonly owner: string | null; readonly segment: string;
    readonly field: "audioText" | "heading"; readonly from: number; readonly to: number; readonly html: string }
  | { readonly kind: "scene-with-no-beats"; readonly heading: Readonly<Record<string, unknown>>; readonly beforeRowId: string | null }
  | { readonly kind: "removed-heading"; readonly heading: Readonly<Record<string, unknown>>; readonly removal?: SharedRecoveryRemoval };

export function sharedRecoveryIdentityKey(identity: { readonly client: number; readonly clock: number }): string {
  return identity.client + ":" + identity.clock;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function projectSharedRecoveryRemoval(parts: readonly { readonly removals: readonly SharedRecoveryRemovalSource[]; readonly units: readonly SharedProjectionUnit[] }[]): SharedRecoveryRemoval | null {
  const ids = new Set<string>(), by = new Set<string>(), edited: { client: number; clock: number }[] = [];
  for (const part of parts) {
    for (const removal of part.removals) { ids.add(removal.key); by.add(removal.by); }
    for (const unit of part.units) {
      const identity = unit.identity;
      if (identity && part.removals.some(removal => !removal.observed.has(sharedRecoveryIdentityKey(identity)))) edited.push({ client: identity.client, clock: identity.clock });
    }
  }
  return ids.size ? { ids: [...ids].sort(compare), by: [...by].sort(compare).join(", "), edited } : null;
}

export interface SharedCoverageBlock { readonly id: string; readonly segment: string; readonly units: readonly SharedProjectionUnit[] }

export function projectSharedCoveredBeats(blocks: readonly SharedCoverageBlock[], removed: ReadonlySet<string>,
  sources: ReadonlyMap<string, readonly SharedRecoveryRemovalSource[]>): Map<string, SharedRecoveryRemovalSource[]> {
  const bySegment = new Map<string, SharedRecoveryRemovalSource[]>(), covered = new Map<string, SharedRecoveryRemovalSource[]>();
  for (const block of blocks) if (removed.has(block.id)) {
    const list = bySegment.get(block.segment) ?? [];
    for (const source of sources.get(block.id) ?? []) if (!list.includes(source)) list.push(source);
    bySegment.set(block.segment, list);
  }
  for (const block of blocks) {
    const candidates = removed.has(block.id) ? undefined : bySegment.get(block.segment);
    if (!candidates?.length) continue;
    const covering = candidates.filter(source => block.units.some(unit => unit.identity !== undefined && source.observed.has(sharedRecoveryIdentityKey(unit.identity))));
    if (covering.length) covered.set(block.id, covering);
  }
  return covered;
}

export type SharedLostCommentEntry = Extract<SharedRecoveryEntry, { readonly kind: "comment-without-words" | "reply-without-comment" }>;

export function projectSharedLostComments(comments: readonly Readonly<Record<string, unknown>>[], words: ReadonlySet<string>,
  replies: readonly { readonly key: string; readonly fields: Readonly<Record<string, unknown>> }[]): SharedLostCommentEntry[] {
  const out: SharedLostCommentEntry[] = [], known = new Set<unknown>();
  for (const comment of [...comments].sort((a, b) => compare(String(a.id), String(b.id)))) {
    known.add(comment.id);
    const anchor = comment.anchorId;
    // why: only a text comment has words; picture, moved-media and conflict comments carry an empty quote.
    const text = typeof comment.quotedText === "string" && comment.quotedText !== "" && comment.kind !== "conflict" && comment.field !== "title" && comment.field !== "visualImage";
    if (typeof comment.id !== "string" || typeof anchor !== "string" || !anchor || !text || words.has(anchor)) continue;
    out.push({ kind: "comment-without-words", comment: comment.id, rowId: typeof comment.rowId === "string" ? comment.rowId : null,
      field: typeof comment.field === "string" ? comment.field : null });
  }
  for (const reply of [...replies].sort((a, b) => compare(a.key, b.key))) {
    const parent = reply.fields.commentId;
    if (typeof parent === "string" && !known.has(parent)) out.push({ kind: "reply-without-comment", reply: reply.key, commentId: parent });
  }
  return out;
}
