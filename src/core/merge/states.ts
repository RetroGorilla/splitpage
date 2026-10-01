import { SCHEMA_VERSION, STATE_FIELDS } from "../document/fields.ts";
import type { StateField, StrategyId } from "../document/fields.ts";
import { mergedDocId } from "../document/ids.ts";
import { mergePersonColors } from "../document/person-colors.ts";
import type { Clock, IdSource } from "../document/ports.ts";
import { LIST_MERGERS } from "./lists.ts";
import type { ListMerger, TagEntry, TagList } from "./lists.ts";
import { conflictComment, mergeComments, mergeRows } from "./rows.ts";
import type { MergeComment, MergeConflict, MergeRow, MergeStats, RowSide } from "./rows.ts";
import { mergeChangedSideWins, mergeMaxPlusOne, mergeTargetLength, mergeTheirsWins, mergeTitle } from "./scalars.ts";
import { textMergeContext } from "./text-field.ts";
import type { MergeDecoder } from "./text-field.ts";

export interface MergeDoc extends RowSide {
  title?: unknown;
  docId?: unknown;
  productionTags?: TagList;
  targetSeconds?: unknown;
  [key: string]: unknown;
}

export interface MergePorts {
  decode: MergeDecoder;
  ids: IdSource;
  clock: Clock;
  editor: () => string;
  fields?: readonly StateField[] | undefined;
}

export interface StateMerge {
  merged: Record<string, unknown>;
  conflicts: MergeConflict[];
  stats: MergeStats;
}

interface FieldRun {
  base: MergeDoc | null | undefined;
  mine: MergeDoc;
  theirs: MergeDoc;
  out: Record<string, unknown>;
  tagField: StateField;
  tags: unknown[];
  rows: MergeRow[];
  comments: MergeComment[];
  title: unknown;
}

type FieldStrategy = (f: StateField, run: FieldRun) => void;

function listMerger(f: StateField): ListMerger {
  return (Object.prototype.hasOwnProperty.call(LIST_MERGERS, f.key) ? LIST_MERGERS[f.key] : undefined) as ListMerger;
}

const STRATEGY_TABLE: Record<StrategyId, FieldStrategy> = {
  "title": function (f, run) { run.out[f.key] = run.title; },
  "doc-id": function (f, run) { run.out[f.key] = mergedDocId(run.base, run.mine, run.theirs); },
  "rows": function (f, run) { run.out[f.key] = run.rows; },
  "comments": function (f, run) { run.out[f.key] = run.comments; },
  "list-union-with-base": function (f, run) {
    run.out[f.key] = f === run.tagField ? run.tags : listMerger(f)(run.base && run.base[f.key], run.mine[f.key], run.theirs[f.key]);
  },
  "changed-side-wins": function (f, run) { run.out[f.key] = mergeChangedSideWins(f, run.base, run.mine, run.theirs); },
  "max-plus-one": function (f, run) { run.out[f.key] = mergeMaxPlusOne(f.key, run.mine, run.theirs); },
  "theirs-wins": function (f, run) { run.out[f.key] = mergeTheirsWins(f.key, run.mine, run.theirs); },
  "person-colors": function (f, run) {
    const pc = mergePersonColors(run.base && run.base[f.key], run.mine[f.key], run.theirs[f.key]);
    if (pc) run.out[f.key] = pc;
  },
  "target-length": function (f, run) {
    const tl = mergeTargetLength(run.base, run.mine, run.theirs);
    if (tl !== null) run.out[f.key] = tl;
  },
  "constant": function (f, run) { run.out[f.key] = SCHEMA_VERSION; }
};

const STRATEGIES: Readonly<Record<StrategyId, FieldStrategy>> = Object.freeze(STRATEGY_TABLE);

function strategyFor(f: StateField): FieldStrategy {
  if (!Object.prototype.hasOwnProperty.call(STRATEGIES, f.merge)) throw new Error("no merge strategy for state field " + f.key);
  return STRATEGIES[f.merge];
}

export function mergeStateFields(base: MergeDoc | null | undefined, mine: MergeDoc, theirs: MergeDoc, ports: MergePorts): StateMerge {
  const fields = ports.fields || STATE_FIELDS;
  const conflicts: MergeConflict[] = [];
  const stats: MergeStats = { rowsFromThem: 0, rowsFromMe: 0, rowsAddedByMe: 0, rowsAddedByThem: 0 };

  const tagField = fields.filter(function (f) { return f.key === "productionTags"; })[0] as StateField;
  const mergedTags = listMerger(tagField)(base && base.productionTags, mine.productionTags, theirs.productionTags);
  const textCtx = textMergeContext(ports.decode, base, mine, theirs, mergedTags as TagEntry[]);

  const rows = mergeRows(base, mine, theirs, { text: textCtx, conflicts: conflicts, stats: stats, clock: ports.clock, editor: ports.editor });
  const comments = mergeComments(base, mine, theirs);
  const title = mergeTitle(base, mine, theirs, conflicts);
  conflicts.forEach(function (c) { comments.push(conflictComment(c, ports)); });

  const run: FieldRun = {
    base: base, mine: mine, theirs: theirs, out: {},
    tagField: tagField, tags: mergedTags, rows: rows, comments: comments, title: title
  };
  fields.forEach(function (f) { strategyFor(f)(f, run); });
  return { merged: run.out, conflicts: conflicts, stats: stats };
}
