import { readFileSync } from "node:fs";
import type { CollabIdentity, CollabModel } from "../model.ts";
import type { SplitRepairSnapshot, SplitTraceEntry } from "../split-reconcile/records.ts";
import type { BufferTrace } from "../../test/buffer-oracles.ts";

export interface StalePaintObservation {
  dom: string; selection: [number, number] | null; selectedElement: number | null;
  paintHeld: boolean; dirty: boolean; composing: boolean; nativeBaseChanged: boolean;
  painted: { id: string; value: string; names: string[]; identities: CollabIdentity[]; version: string } | null;
  model: CollabModel;
}
export interface StaleProbeSnapshot {
  state: StalePaintObservation;
  states: { site: string; state: StalePaintObservation; input?: { trusted: boolean; type: string; data: string | null; defaultPrevented: boolean; ranges: ([number, number] | null)[] } }[];
}
export interface StaleReplayStage {
  phase: string; binding: SplitRepairSnapshot & { preserveStalePaint: boolean }; probe: StaleProbeSnapshot;
}
export interface StaleReplayCase {
  trace: BufferTrace; order: string; status: "PASS" | "FAIL"; failure: string | null; stages: StaleReplayStage[];
}
export interface SplitStaleEvidence {
  appCommit: string; baseHead: string; candidate: "B"; mechanism: "M1"; browser: string; bundleSha256: string;
  off: { rows: number; writer: null; split: null }; controls: StaleReplayCase[]; cases: StaleReplayCase[];
}
export interface StaleLocalizationCase {
  surface: "split" | "writer" | "repaired"; bundleSha256: string; failure: string | null; remoteTrace: SplitTraceEntry[];
  probe: StaleProbeSnapshot; snapshot: SplitRepairSnapshot;
}
export interface SplitStaleLocalization {
  appCommit: string; browser: string; diagnostic: string; cases: StaleLocalizationCase[];
}
export function readSplitStaleEvidence(): SplitStaleEvidence {
  return JSON.parse(readFileSync(new URL("../../split-stale/evidence.json", import.meta.url), "utf8")) as SplitStaleEvidence;
}
export function readSplitStaleLocalization(): SplitStaleLocalization {
  return JSON.parse(readFileSync(new URL("../../split-stale/localization.json", import.meta.url), "utf8")) as SplitStaleLocalization;
}
