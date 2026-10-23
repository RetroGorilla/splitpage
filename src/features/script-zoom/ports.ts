import type { ActionRegistry } from "../../application/actions.ts";
import type { DocumentView } from "../../application/session/document-session.ts";

export interface ScriptZoomPorts {
  readonly currentDocument: () => DocumentView | null;
  readonly prompterIsOpen: () => boolean;
  readonly runAction: ActionRegistry["invoke"];
  readonly scriptScale: () => number;
  readonly setScriptScale: (scale: number) => void;
  readonly clearScriptScale: () => void;
  readonly isScriptScaleKey: (key: string | null) => boolean;
  readonly preferenceEvent: string;
  readonly writerOpen: () => boolean;
  readonly hideShot: () => boolean;
}
