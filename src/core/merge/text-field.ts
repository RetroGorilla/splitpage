import { ensureTagIds, registryTagHooks } from "../document/tags.ts";
import type { TagHooks, TagName, TagRecord } from "../document/tags.ts";
import { toHtml } from "../text/html.ts";
import type { CellDecoder } from "../text/ports.ts";
import { sameCell } from "../text/runs.ts";
import type { Run } from "../text/runs.ts";
import { mergeCells } from "./cells.ts";
import { mergeProductionTags } from "./lists.ts";
import type { TagInput, TagList } from "./lists.ts";

export interface TagSide {
  productionTags?: TagList;
}

type Registry = readonly (TagRecord | null | undefined)[] | null | undefined;

export interface TextMergeContext {
  hasBase: boolean;
  base: TagHooks;
  mine: TagHooks;
  theirs: TagHooks;
  out: {
    tagId: (cat: string, name: string) => string;
    tagOf: (id: unknown) => TagName | null;
  };
  refit: { mine: boolean; theirs: boolean };
  decode: CellDecoder;
}

export type TextOutcome = "same" | "mine" | "theirs" | "merged" | "conflict";

export interface TextMerge {
  html: string;
  outcome: TextOutcome;
  marks?: boolean;
  withMine?: boolean;
}

interface CellRead {
  cell: readonly Run[];
  media: boolean;
}

function tagHooksFor(tags: TagList): TagHooks {
  let list = tags || [];
  if (list.some(function (t) { return t && !t.id; })) {
    list = list.map(function (t) { return t && Object.assign({}, t); });
    ensureTagIds(list as (TagRecord | null | undefined)[]);
  }
  return registryTagHooks(list as Registry);
}

function registryRenamed(sideTags: TagList, mergedTags: Registry): boolean {
  const merged: Record<string, TagRecord> = {};
  (mergedTags || []).forEach(function (t) { if (t && t.id) merged[t.id] = t; });
  return (sideTags || []).some(function (t) {
    const m = t && t.id && merged[t.id];
    return !!m && (m.cat !== (t as TagInput).cat || m.name !== (t as TagInput).name);
  });
}

export function textMergeContext(decode: CellDecoder, base: TagSide | null | undefined, mine: TagSide, theirs: TagSide, mergedTags?: Registry): TextMergeContext {
  const baseTags = base && base.productionTags;
  if (mergedTags === undefined) mergedTags = mergeProductionTags(baseTags, mine.productionTags, theirs.productionTags);
  const hb = tagHooksFor(baseTags), hm = tagHooksFor(mine.productionTags), ht = tagHooksFor(theirs.productionTags);
  const hout = registryTagHooks(mergedTags);
  return {
    hasBase: !!base,
    base: hb,
    mine: hm,
    theirs: ht,
    out: {
      tagId: hout.tagId,
      tagOf: function (id) { return hout.tagOf(id) || ht.tagOf(id) || hm.tagOf(id) || hb.tagOf(id); }
    },
    refit: {
      mine: registryRenamed(mine.productionTags, mergedTags),
      theirs: registryRenamed(theirs.productionTags, mergedTags)
    },
    decode: decode
  };
}

function readCell(html: string, hooks: TagHooks, decode: CellDecoder): CellRead {
  let media = false;
  const cell = decode(html, { tagId: hooks.tagId, onMedia: function () { media = true; } });
  return { cell: cell, media: media };
}

function refitCell(html: string, side: "mine" | "theirs", ctx: TextMergeContext): string {
  if (!ctx.refit[side] || html.indexOf("tag-anchor") === -1) return html;
  const cell = ctx.decode(html, { tagId: ctx[side].tagId });
  if (sameCell(ctx.decode(html, { tagId: ctx.out.tagId }), cell)) return html;
  return toHtml(cell, { tagOf: ctx.out.tagOf });
}

export function mergeTextField(base: unknown, mine: unknown, theirs: unknown, ctx: TextMergeContext): TextMerge {
  const bv = base == null ? "" : String(base), mv = mine == null ? "" : String(mine), tv = theirs == null ? "" : String(theirs);
  const hasBase = ctx.hasBase && base !== undefined;
  if (mv === tv) return { html: refitCell(tv, "theirs", ctx), outcome: "same" };

  const M = readCell(mv, ctx.mine, ctx.decode), T = readCell(tv, ctx.theirs, ctx.decode);
  const B = !hasBase ? null : bv === mv ? M : bv === tv ? T : readCell(bv, ctx.base, ctx.decode);
  if (M.media || T.media || (B && B.media)) {
    if (hasBase && mv === bv) return { html: tv, outcome: "theirs" };
    if (hasBase && tv === bv) return { html: mv, outcome: "mine" };
    return { html: tv, outcome: "conflict" };
  }
  if (sameCell(M.cell, T.cell)) return { html: refitCell(tv, "theirs", ctx), outcome: "same" };
  if (!hasBase) return { html: refitCell(tv, "theirs", ctx), outcome: "conflict" };

  const O = B as CellRead;
  const mineChanged = mv !== bv && !sameCell(M.cell, O.cell);
  const theirsChanged = tv !== bv && !sameCell(T.cell, O.cell);
  if (!mineChanged) return { html: refitCell(tv, "theirs", ctx), outcome: "theirs" };
  if (!theirsChanged) return { html: refitCell(mv, "mine", ctx), outcome: "mine" };

  const r = mergeCells(O.cell, M.cell, T.cell);
  if (r.conflict) return { html: refitCell(tv, "theirs", ctx), outcome: "conflict" };
  const res: TextMerge = sameCell(r.cell, T.cell) ? { html: refitCell(tv, "theirs", ctx), outcome: "theirs" }
    : sameCell(r.cell, M.cell) ? { html: refitCell(mv, "mine", ctx), outcome: "mine" }
    : { html: toHtml(r.cell, { tagOf: ctx.out.tagOf }), outcome: "merged" };
  if (!r.markConflicts) return res;
  return { html: res.html, outcome: "conflict", marks: true, withMine: res.outcome !== "theirs" };
}
