import { refreshAnnotator } from "../../js/05w-annotate.js";
import { onSessionChange } from "../../legacy/session-bridge.ts";

export function listenAnnotator(): () => void {
  return onSessionChange(refreshAnnotator);
}
