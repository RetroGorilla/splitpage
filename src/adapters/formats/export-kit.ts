import type { ExportServices } from "../../application/export/services.ts";
import type { ExportDocument } from "../../core/document/export-document.ts";
import { exportServices } from "../../application/export/services.ts";
import { DEFAULT_WPM, targetLengthOf } from "../../core/document/timing.ts";
import { brollSortedForList } from "../../core/production/broll.ts";
import { TAG_CATEGORIES, rowStatus } from "../../core/production/looks.ts";
import { formatDuration, pad2, rowSeconds as rowSecondsIn, targetClock } from "../../core/production/timing.ts";
import { tagPrintColor } from "./print-colors.ts";
import { breakdownRows, commentEntries, sceneFacts, shotRecordForFile } from "./export-projections.ts";
import type { CommentEntry, CommentOptions, ShotRecord } from "./export-projections.ts";
import { toDocxRuns } from "../../core/text/projections.ts";
import type { DocxRun } from "../../core/text/projections.ts";

export type ExportRun = Omit<DocxRun, "tag"> & {
  tag?: { cat: string; name: string; color?: string | null };
  markers?: number[];
};

export function exportRuns(html: unknown, nums: Readonly<Record<string, number>>, services: ExportServices = exportServices()): ExportRun[] {
  const runs: ExportRun[] = toDocxRuns(services.cellOf(html), { annotate: true });
  runs.forEach(function (r, i) {
    if (r.tag) r.tag = { cat: r.tag.cat, name: r.tag.name, color: tagPrintColor(r.tag.cat) };
    if (!r.cmt) return;
    let next: ExportRun | null = null;
    for (let k = i + 1; k < runs.length; k++) {
      const candidate = runs[k];
      if (!candidate) throw new Error("Missing export run");
      if (candidate.dir && (candidate.text === "(" || candidate.text === ")") && !candidate.cmt) continue;
      next = candidate;
      break;
    }
    const nextIds = (next && next.cmt) || [];
    const ending = r.cmt.filter(function (id) { return nextIds.indexOf(id) === -1 && nums[id]; }).reverse();
    if (ending.length) r.markers = ending.map(function (id) {
      const number = nums[id];
      if (number === undefined) throw new Error("Missing export comment number");
      return number;
    });
  });
  return runs;
}

export interface ExportFacts {
  title: string;
  scenes: number;
  seconds: number;
  runtime: string;
  target: { seconds: number; text: string; delta: string; over: boolean } | null;
  status: { todo: number; ready: number; shot: number };
  words: number;
  wpm: number;
  exportedAt: Date;
  date: string;
}
export interface ExportComment extends CommentEntry {
  number: number | null;
  scene: string;
  where: string;
}
export interface BrollScene {
  label: string;
  scene: string;
  start: string;
  done: number;
  total: number;
  items: (ShotRecord & { id: string })[];
}
export const PRINT_COLORS = {
  text: "171613",
  dim: "4E4D48",
  faint: "64635E",
  border: "DCDAD4",
  borderStrong: "C9C7C1",
  surface2: "E9E8E4",
  visual: "2863AB",
  visualSoft: "E3ECF7",
  audio: "9E5800",
  audioSoft: "F6EBDC",
  broll: "00717F"
};

export const STATUS_PRINT = {
  todo: { color: PRINT_COLORS.faint, lamp: "outline" },
  ready: { color: PRINT_COLORS.audio, lamp: "fill" },
  shot: { color: PRINT_COLORS.text, lamp: "check" }
};

export const TAG_STATUS_PRINT = {
  needed: { color: PRINT_COLORS.faint, lamp: "outline" },
  sourcing: { color: PRINT_COLORS.audio, lamp: "half" },
  have: { color: PRINT_COLORS.text, lamp: "fill" },
  returned: { color: PRINT_COLORS.faint, lamp: "ring" }
};

export function exportDateText(d: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(d);
  } catch (e) {
    return d.toDateString();
  }
}

function plural(n: number, one: string, many?: string): string { return n + " " + (n === 1 ? one : (many || one + "s")); }

export function exportDay(doc: ExportDocument): Date {
  const at = new Date(doc.capturedAt);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

export function exportFacts(doc: ExportDocument, services: ExportServices = exportServices()): ExportFacts {
  const s = doc.document;
  const readers = services.productionReaders;
  const rows = s.rows || [];
  let seconds = 0, words = 0;
  const status = { todo: 0, ready: 0, shot: 0 };
  rows.forEach(function (r) {
    seconds += rowSecondsIn(r, s, readers);
    words += readers.wordCount(r.audioText);
    const st = rowStatus(r.status) || rowStatus("todo");
    if (!st) throw new Error("Missing row status");
    status[st.id]++;
  });
  const target = targetLengthOf({ targetSeconds: s.targetSeconds });
  const clock = target === null ? null : targetClock(seconds, target);
  const when = new Date(doc.capturedAt);
  return {
    title: s.title || "Untitled Script",
    scenes: rows.length,
    seconds: seconds,
    runtime: formatDuration(seconds),
    target: clock ? { seconds: target ?? 0, text: clock.target, delta: clock.delta, over: clock.over } : null,
    status: status,
    words: words,
    wpm: typeof s.wordsPerMinute === "number" && s.wordsPerMinute ? s.wordsPerMinute : DEFAULT_WPM,
    exportedAt: when,
    date: exportDateText(when)
  };
}

export function exportSummaryParts(facts: ExportFacts): string[] {
  const out = [plural(facts.scenes, "scene"), facts.runtime + " running time"];
  if (facts.target) {
    out.push("Target " + facts.target.text + " · " +
      (facts.target.delta === "0:00" ? "on target" : facts.target.delta + (facts.target.over ? " over" : " under")));
  }
  if (facts.scenes) out.push(facts.status.shot + " of " + facts.scenes + " shot");
  return out;
}

export function exportComments(doc: ExportDocument, opts?: CommentOptions | null, services: ExportServices = exportServices()): ExportComment[] {
  const nums = doc.commentNumbers;
  const list: ExportComment[] = commentEntries(doc, Object.assign({ clockMode: doc.clockMode }, opts || { pieces: true }), services).map(function (c) {
    const scene = c.rowIndex >= 0 ? pad2(c.rowIndex + 1) : "";
    const field = c.field === "audioText" ? "Audio" : "Visual";
    return Object.assign(c, {
      number: nums[c.id] || null,
      scene: scene,
      where: c.field === "title" ? "Document title" : scene ? "Scene " + scene + " · " + field : "Deleted scene"
    });
  });
  let i = 0;
  while (i < list.length) {
    const first = list[i];
    if (!first) throw new Error("Missing export comment");
    let j = i;
    const slots: number[] = [];
    const numbered: ExportComment[] = [];
    while (j < list.length) {
      const entry = list[j];
      if (!entry || entry.rowIndex !== first.rowIndex || entry.field !== first.field) break;
      if (entry.number) { slots.push(j); numbered.push(entry); }
      j++;
    }
    numbered.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    slots.forEach((slot, index) => {
      const entry = numbered[index];
      if (!entry) throw new Error("Missing numbered export comment");
      list[slot] = entry;
    });
    i = j;
  }
  return list;
}

export function breakdownGroups(doc: ExportDocument) {
  const rows = breakdownRows(doc);
  return TAG_CATEGORIES.map(function (cat) {
    return {
      catId: cat.id,
      label: cat.plural,
      color: tagPrintColor(cat.id),
      items: rows.filter(function (r) { return r.catId === cat.id; })
    };
  }).filter(function (g) { return g.items.length; });
}

export function exportBrollScenes(doc: ExportDocument, services: ExportServices = exportServices()): BrollScene[] {
  const facts = sceneFacts(doc, services);
  const groups: BrollScene[] = [];
  const byRow: Record<string, BrollScene> = {};
  brollSortedForList(doc.broll).forEach(function (e) {
    const key = e.rowIndex === -1 ? "none" : String(e.rowIndex);
    let g = byRow[key];
    if (!g) {
      const f = e.rowIndex === -1 ? null : facts[e.rowIndex];
      g = byRow[key] = {
        label: f ? "Scene " + f.number : "Not in the script",
        scene: f ? f.number : "",
        start: f ? f.start : "",
        done: 0,
        total: 0,
        items: []
      };
      groups.push(g);
    }
    const rec = { ...shotRecordForFile(e, doc.people), id: e.id };
    g.items.push(rec);
    g.total++;
    if (rec.shot) g.done++;
  });
  return groups;
}

export function brollSummaryText(groups: readonly BrollScene[]): string {
  let all = 0, shot = 0, flagged = 0;
  groups.forEach(function (g) {
    g.items.forEach(function (r) { all++; if (r.shot) shot++; if (r.flagged) flagged++; });
  });
  return shot + " of " + all + " shot" + (flagged ? " · " + flagged + " flagged" : "");
}
