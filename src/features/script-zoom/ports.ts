import type { ActionRegistry } from "../../application/actions.ts";
import type { PreferenceChanges, Preferences } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";

export interface ScriptZoomPorts {
  readonly screen: () => ScreenState;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly scale: Pick<Preferences, "scriptScale" | "setScriptScale" | "clearScriptScale">;
  readonly changes: PreferenceChanges;
}
