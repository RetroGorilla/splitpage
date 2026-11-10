import { readFileSync } from "node:fs";
import type { AppBindingSnapshot } from "../app-binding/run.ts";
import type { BufferTrace } from "../../test/buffer-oracles.ts";
import { publicBEvidence } from "../b-surfaces/public.ts";

export interface SplitRepairSnapshot extends AppBindingSnapshot {
  candidate: "B"; segments: string[];
  syncs: { id: string; text: string; composing: boolean }[];
  coordination: { enabled: boolean; reconciling: boolean; nestedPaintsSuppressed: number };
  remoteNodesPreserved: boolean | null;
  app: { document: { rows: { id: string; audioText: string }[] }; generation: number; counts: { compositionMark: number; dropEmptySince: number; hold: number } };
}
export interface SplitRepairCase {
  trace: BufferTrace; mechanism: "M1"; order: string; status: "PASS" | "FAIL"; difference: string | null; stages: SplitRepairSnapshot[];
}
export interface SplitRepairEvidence {
  appCommit: string; baseHead: string; browser: string; bundleSha256: string; repair: string;
  off: { rows: number; writer: null; split: null }; controls: SplitRepairCase[]; cases: SplitRepairCase[];
}
export interface SplitTraceEntry {
  site: string; depth: number; stack: string;
  detail?: string | { phase?: number; source?: string; parent?: string; old?: string; fresh?: string };
}
export interface SplitLocalizationCase {
  mode: "binding" | "guarded" | "standalone"; kind: string; sourceCommit: string; sourceTree: string; diagnosticHtmlHash: string;
  failure: string | null; trace: SplitTraceEntry[];
  snapshot: SplitRepairSnapshot | { rows: number; model: { id: string; audioText: string }[]; dom: { id: string; text: string }[] };
}
export interface SplitLocalizationEvidence {
  browser: string; diagnostic: string; probes: { file: string; site: string }[]; cases: SplitLocalizationCase[];
}

export function readSplitRepairEvidence(): SplitRepairEvidence {
  return JSON.parse(readFileSync(new URL("../../split-reconcile/evidence.json", import.meta.url), "utf8")) as SplitRepairEvidence;
}
export function readSplitLocalization(): SplitLocalizationEvidence {
  return JSON.parse(readFileSync(new URL("../../split-reconcile/localization.json", import.meta.url), "utf8")) as SplitLocalizationEvidence;
}

export function serializeSplitRecord(value: unknown): string {
  const record = JSON.parse(publicBEvidence(value)) as Record<string, unknown>;
  const entries = Object.entries(record);
  return ["{", ...entries.flatMap(([key, item], index) => {
    const suffix = index === entries.length - 1 ? "" : ",";
    if (!Array.isArray(item)) return [`  ${JSON.stringify(key)}: ${JSON.stringify(item)}${suffix}`];
    return [`  ${JSON.stringify(key)}: [`, ...item.map((entry: unknown, at: number) => `    ${JSON.stringify(entry)}${at === item.length - 1 ? "" : ","}`), `  ]${suffix}`];
  }), "}", ""].join("\n");
}
