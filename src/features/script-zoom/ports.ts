import type { ActionRegistry } from "../../application/actions.ts";

export interface ScriptZoomPorts {
  readonly hasDocument: () => boolean;
  readonly prompterIsOpen: () => boolean;
  readonly runAction: ActionRegistry["invoke"];
  readonly scriptScale: () => number;
  readonly setScriptScale: (scale: number) => void;
  readonly clearScriptScale: () => void;
  readonly isScriptScaleKey: (key: string | null) => boolean;
  readonly preferenceEvent: string;
  readonly writerOpen: () => boolean;
}
