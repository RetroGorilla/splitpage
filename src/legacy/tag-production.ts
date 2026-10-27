import type { TagWrite } from "../core/production/tags.ts";

interface TagProductionHandOff {
  readonly productionIndexStats: () => { derived: number; flushes: number };
  readonly resetProductionIndexStats: () => void;
  readonly scheduleUntaggedScan: () => void;
  readonly tagFieldOccurrences: (html: string, phrase: string, cat: string, name: string, countOnly: boolean, onlyOccurrence?: number) => TagWrite;
  readonly hideTagGhost: () => void;
  readonly scheduleIdleRefresh: (job: string) => void;
}

export let productionIndexStats: TagProductionHandOff["productionIndexStats"];
export let resetProductionIndexStats: TagProductionHandOff["resetProductionIndexStats"];
export let scheduleUntaggedScan: TagProductionHandOff["scheduleUntaggedScan"];
export let tagFieldOccurrences: TagProductionHandOff["tagFieldOccurrences"];
export let hideTagGhost: TagProductionHandOff["hideTagGhost"];
export let scheduleIdleRefresh: TagProductionHandOff["scheduleIdleRefresh"];

export function handTagProductionTo(tags: TagProductionHandOff): void {
  productionIndexStats = tags.productionIndexStats;
  resetProductionIndexStats = tags.resetProductionIndexStats;
  scheduleUntaggedScan = tags.scheduleUntaggedScan;
  tagFieldOccurrences = tags.tagFieldOccurrences;
  hideTagGhost = tags.hideTagGhost;
  scheduleIdleRefresh = tags.scheduleIdleRefresh;
}
