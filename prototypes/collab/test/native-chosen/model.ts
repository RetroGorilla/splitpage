import { advance as advanceE9, need } from "../native-delete/model.ts";
import type { DeleteCommand, Marker, StoredReading, VisibleEntry } from "../native-delete/model.ts";

export interface ModelRules { prefix: boolean; empty: boolean; repeat: boolean; adjacent: boolean }
export const MODEL_RULES: ModelRules = { prefix: true, empty: true, repeat: true, adjacent: true };
export const STRAY = "~stray";

export interface ModelSpan { segment: string; start: number; end: number; opened: "head" | "embed" | null; text: string }
export interface ModelEntry { id: string; kind: "b" | "h"; spans: ModelSpan[] }

const keyOf = (marker: Marker): string => `${marker.kind}:${marker.id}`;

function segmentSpans(stored: StoredReading, segment: string): { key: string | null; span: ModelSpan }[] {
  const { head, units } = need(stored.segments[segment], segment);
  let current: ModelSpan = { segment, start: 0, end: 0, opened: head ? "head" : null, text: "" };
  const result = [{ key: head ? keyOf(head) : null, span: current }];
  units.forEach((unit, index) => {
    if (typeof unit === "string") { current.text += unit; current.end = index + 1; return; }
    current = { segment, start: index + 1, end: index + 1, opened: "embed", text: "" };
    result.push({ key: keyOf(unit), span: current });
  });
  return result;
}

// why: rules a to c written from their wording over plain data: leading text goes to the segment's first beat, else
// the beat above in storage order, else the first beat; with no beat it is one row; a repeated boundary folds
export function ownership(stored: StoredReading, rules: ModelRules = MODEL_RULES): { entries: ModelEntry[]; stray: ModelSpan[] } {
  const entries = new Map<string, ModelEntry>();
  let lastBeat: ModelEntry | null = null;
  const top: ModelSpan[] = [];
  for (const segment of new Set(stored.order)) {
    const here: ModelEntry[] = [], leading: ModelSpan[] = [];
    let previous: ModelEntry | null = null;
    for (const { key, span } of segmentSpans(stored, segment)) {
      const filled = span.end > span.start;
      if (key === null) { if (filled) leading.push(span); continue; }
      const known = entries.get(key);
      if (known) {
        if (!rules.repeat) continue;
        if (previous) previous.spans.push(span); else if (filled) leading.push(span);
        continue;
      }
      const entry: ModelEntry = { id: key.slice(2), kind: key.startsWith("h:") ? "h" : "b", spans: [span] };
      entries.set(key, entry); here.push(entry); previous = entry;
    }
    if (leading.length) {
      const first = here.find(entry => entry.kind === "b");
      if (rules.prefix && first) first.spans.unshift(...leading);
      else if (rules.prefix && lastBeat) lastBeat.spans.push(...leading);
      else if (rules.prefix || rules.empty) top.push(...leading);
    }
    lastBeat = here.filter(entry => entry.kind === "b").at(-1) ?? lastBeat;
  }
  const list = [...entries.values()], first = list.find(entry => entry.kind === "b");
  let stray: ModelSpan[] = [];
  if (top.length && first && rules.prefix) first.spans.unshift(...top);
  else if (top.length && !first && rules.empty) stray = top;
  return { entries: list, stray };
}

const textOf = (entry: ModelEntry): string => entry.spans.map(span => span.text).join("");

export function ruleView(stored: StoredReading, rules: ModelRules = MODEL_RULES): VisibleEntry[] {
  const { entries, stray } = ownership(stored, rules), result: VisibleEntry[] = [];
  if (stray.length) result.push({ id: STRAY, members: [STRAY], audio: stray.map(span => span.text).join(""), visual: "" });
  let row: Extract<VisibleEntry, { id: string }> | undefined, visible: string | null = null;
  for (const entry of entries) {
    const text = textOf(entry);
    if (entry.kind === "h") {
      if (stored.headings[entry.id]?.removed) continue;
      result.push({ heading: entry.id, name: text });
      row = undefined; visible = null;
      continue;
    }
    const record = stored.beats[entry.id], cell = stored.visuals[entry.id] ?? "";
    const joins = !!record?.joined && !!row && (!rules.adjacent || record.joined.into === visible);
    visible = entry.id;
    if (!joins || !row) {
      row = { id: entry.id, members: [], audio: "", visual: "", ...record?.status && { status: record.status } };
      result.push(row);
    }
    row.members.push(entry.id);
    row.audio += (row.audio && text ? record?.joined?.glue ?? "" : "") + text;
    row.visual += (row.visual && cell ? "\n" : "") + cell;
  }
  return result;
}

function removeBeats(stored: StoredReading, ids: ReadonlySet<string>): void {
  const owned = ownership(stored).entries.filter(entry => entry.kind === "b" && ids.has(entry.id));
  const cuts = new Map<string, Set<number>>();
  for (const entry of owned) for (const span of entry.spans) {
    const set = cuts.get(span.segment) ?? new Set<number>();
    for (let index = span.opened === "embed" ? span.start - 1 : span.start; index < span.end; index++) set.add(index);
    cuts.set(span.segment, set);
    if (span.opened === "head") need(stored.segments[span.segment], span.segment).head = null;
  }
  for (const [segment, gone] of cuts) {
    const tape = need(stored.segments[segment], segment);
    tape.units = tape.units.filter((_, index) => !gone.has(index));
  }
  for (const id of ids) { Reflect.deleteProperty(stored.beats, id); Reflect.deleteProperty(stored.visuals, id); }
}

export function rowMembers(stored: StoredReading, rows: readonly string[]): Set<string> {
  return new Set(ruleView(stored).flatMap(entry => "id" in entry && rows.includes(entry.id) ? entry.members : []));
}

export function sceneRows(stored: StoredReading, heading: string): string[] {
  const view = ruleView(stored), start = view.findIndex(entry => "heading" in entry && entry.heading === heading), rows: string[] = [];
  for (const entry of view.slice(start + 1)) { if ("heading" in entry) break; rows.push(entry.id); }
  return rows;
}

// why: the combination's deletion and heading removal; every other command keeps the E9 model's effect
export function advanceChosen(before: StoredReading, command: DeleteCommand): StoredReading {
  if (command.op === "heading") return advanceE9(before, { ...command, removal: "flag" }, "keep");
  if (command.op !== "rows" && command.op !== "scene") return advanceE9(before, command, "keep");
  const next = structuredClone(before);
  const rows = command.op === "rows" ? command.ids : sceneRows(before, command.id);
  removeBeats(next, rowMembers(before, rows));
  if (command.op === "scene") next.headings[command.id] = { ...next.headings[command.id], removed: true };
  return next;
}
