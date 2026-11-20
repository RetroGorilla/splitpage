import { tagStack } from "../../../core/text/runs.ts";
import type { Run } from "../../../core/text/runs.ts";
import type { NativeReadBeat } from "./reader.ts";
import { sameNativeValue } from "./values.ts";

interface CountChange {
  readonly delta: number;
  readonly wanted: number;
}

type Counts = readonly (readonly [string, CountChange])[];

interface OrderChange {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface NativeNoticeCellEffect {
  readonly text: Counts;
  readonly marks: Counts;
  readonly order?: OrderChange;
  readonly markOrder?: OrderChange;
  readonly reading: readonly Run[];
}

interface FieldChange {
  readonly before?: unknown;
  readonly after?: unknown;
}

type Join = NativeReadBeat["joined"];

export interface NativeNoticeEffects {
  readonly narration?: NativeNoticeCellEffect;
  readonly visual?: NativeNoticeCellEffect;
  readonly fields?: readonly (readonly [string, FieldChange])[];
  readonly join?: { readonly before: Join; readonly after: Join };
}

export interface NativeNoticePeriods {
  readonly start: NativeReadBeat | null;
  readonly settled: NativeNoticeEffects;
  readonly prefix?: NativeNoticeEffects;
  readonly peer: boolean;
}

function unitKeys(run: Run): readonly string[] {
  if (!run.atom) return [...run.text];
  const { atom, id, text } = run;
  if (atom === "image") return [JSON.stringify([atom, run.ref])];
  if (atom === "video") return [JSON.stringify([atom, run.href, run.host])];
  if (atom === "who") return [JSON.stringify([atom, run.name, text])];
  return [JSON.stringify([atom, id, text])];
}

function markKeys(run: Run): string[] {
  const marks = Object.entries(run.marks).flatMap(([name, value]) =>
    value === true ? [name] : (name === "cmt" || name === "href") && value ? [JSON.stringify([name, value])] : []);
  for (const tag of tagStack(run.marks)) marks.push("tag:" + tag);
  return marks;
}

function markedOrder(runs: readonly Run[]): string[] {
  return runs.flatMap(run => {
    const marks = markKeys(run);
    return unitKeys(run).map(unit => JSON.stringify([unit, marks]));
  });
}

function unitCounts(runs: readonly Run[], marked: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const marks = marked ? markKeys(run) : [];
    if (marked && !marks.length) continue;
    for (const unit of unitKeys(run)) {
      for (const key of marked ? marks.map(mark => JSON.stringify([unit, mark])) : [unit]) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function delta(before: readonly Run[], after: readonly Run[], marked: boolean): Counts {
  const old = unitCounts(before, marked), current = unitCounts(after, marked);
  return [...new Set([...old.keys(), ...current.keys()])].flatMap(key => {
    const wanted = current.get(key) ?? 0, difference = wanted - (old.get(key) ?? 0);
    return difference ? [[key, { delta: difference, wanted }] as const] : [];
  });
}

function cellEffect(before: readonly Run[], after: readonly Run[]): NativeNoticeCellEffect | undefined {
  if (sameNativeValue(before, after)) return undefined;
  const text = delta(before, after, false), marks = delta(before, after, true);
  const oldOrder = text.length ? [] : before.flatMap(unitKeys), newOrder = text.length ? [] : after.flatMap(unitKeys);
  const order = sameNativeValue(oldOrder, newOrder) ? undefined : { before: oldOrder, after: newOrder };
  if (text.length || marks.length || order) return { text, marks, reading: after, ...order && { order } };
  const markerBefore = markedOrder(before), markerAfter = markedOrder(after);
  return sameNativeValue(markerBefore, markerAfter) ? undefined :
    { text, marks, reading: after, markOrder: { before: markerBefore, after: markerAfter } };
}

export function noticeEffects(before: NativeReadBeat | null, after: NativeReadBeat | null): NativeNoticeEffects {
  if (!before || !after) return {};
  const narration = cellEffect(before.narration, after.narration), visual = cellEffect(before.visual, after.visual);
  const fields = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])].flatMap(key => {
    if (key === "updatedAt" || key === "updatedBy") return [];
    const from = Object.hasOwn(before.fields, key) ? before.fields[key] : undefined;
    const to = Object.hasOwn(after.fields, key) ? after.fields[key] : undefined;
    return sameNativeValue(from, to) ? [] : [[key, {
      ...(from !== undefined && { before: from }), ...(to !== undefined && { after: to })
    }] as const];
  });
  const join = sameNativeValue(before.joined, after.joined) ? undefined : { before: before.joined, after: after.joined };
  return { ...narration && { narration }, ...visual && { visual }, ...fields.length && { fields }, ...join && { join } };
}

function addCounts(earlier: Counts, later: Counts): Counts {
  const counts = new Map(earlier);
  for (const [key, change] of later) {
    const from = counts.get(key);
    if (!from) counts.set(key, change);
    else if (from.delta + change.delta) counts.set(key, { delta: from.delta + change.delta, wanted: Math.max(0, from.wanted + change.delta) });
    else counts.delete(key);
  }
  return [...counts];
}

function addOrder(earlier?: OrderChange, later?: OrderChange): OrderChange | undefined {
  if (!earlier || !later || !sameNativeValue(earlier.after, later.before)) return later ?? earlier;
  return sameNativeValue(earlier.before, later.after) ? undefined : { before: earlier.before, after: later.after };
}

function addCell(earlier?: NativeNoticeCellEffect, later?: NativeNoticeCellEffect): NativeNoticeCellEffect | undefined {
  if (!earlier || !later) return later ?? earlier;
  const text = addCounts(earlier.text, later.text), marks = addCounts(earlier.marks, later.marks);
  const order = addOrder(earlier.order, later.order), markOrder = addOrder(earlier.markOrder, later.markOrder);
  return text.length || marks.length || order || markOrder ?
    { text, marks, reading: later.reading, ...order && { order }, ...markOrder && { markOrder } } : undefined;
}

export function addNoticeEffects(earlier: NativeNoticeEffects, later: NativeNoticeEffects): NativeNoticeEffects {
  const narration = addCell(earlier.narration, later.narration), visual = addCell(earlier.visual, later.visual);
  const fields = new Map(earlier.fields);
  for (const [key, value] of later.fields ?? []) {
    const before = fields.has(key) ? fields.get(key)?.before : value.before;
    if (sameNativeValue(before, value.after)) fields.delete(key);
    else fields.set(key, { ...(before !== undefined && { before }), ...(value.after !== undefined && { after: value.after }) });
  }
  const join = earlier.join && later.join ? { before: earlier.join.before, after: later.join.after } : later.join ?? earlier.join;
  return { ...narration && { narration }, ...visual && { visual }, ...fields.size && { fields: [...fields] },
    ...join && !sameNativeValue(join.before, join.after) && { join } };
}

export function currentNoticeEffects(before: NativeReadBeat | null, after: NativeReadBeat | null, periods?: NativeNoticePeriods): NativeNoticeEffects {
  if (!periods) return noticeEffects(before, after);
  const suffix = addNoticeEffects(periods.settled, noticeEffects(periods.start, after));
  return periods.prefix ? addNoticeEffects(periods.prefix, suffix) : suffix;
}

export function noticeCellClashed(effect: NativeNoticeCellEffect | undefined, merged: readonly Run[] | undefined, marked: boolean): boolean {
  if (!effect) return false;
  const changes = marked ? effect.marks : effect.text, order = marked ? effect.markOrder : effect.order;
  if (!merged) return changes.length > 0 || order !== undefined;
  if (changes.length) {
    const live = unitCounts(merged, marked);
    if (changes.some(([key, { delta, wanted }]) => {
      const kept = live.get(key) ?? 0;
      return delta > 0 ? kept < wanted : kept > wanted;
    })) return true;
  }
  if (!order) return false;
  let at = 0;
  for (const unit of marked ? markedOrder(merged) : merged.flatMap(unitKeys)) if (unit === order.after[at]) at++;
  return at !== order.after.length;
}
