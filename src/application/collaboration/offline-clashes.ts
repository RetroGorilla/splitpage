import type { Run } from "../../core/text/runs.ts";

export interface OfflineBeatReading {
  readonly row: string;
  readonly narration: readonly Run[];
  readonly visual: readonly Run[];
  readonly fields: Readonly<Record<string, unknown>>;
  readonly joined: Readonly<{ into: string; glue: string }> | null;
}

export interface OfflineSavedBeat extends OfflineBeatReading {
  readonly id: string;
  readonly placement: {
    readonly scene: string | null;
    readonly left: string | null;
    readonly right: string | null;
    readonly sceneOrder: readonly string[];
  };
}

export interface OfflineClash {
  readonly id: string;
  readonly mine: OfflineSavedBeat | null;
  readonly near?: string;
}

export interface OfflineClashEntry extends OfflineClash {
  readonly restored: boolean;
}
