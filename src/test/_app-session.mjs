import { getEditorName } from "../legacy/preferences-bridge.ts";
import { runIdleRefresh } from "../js/07-production-tags.js";
import { derivedRecordsPlan } from "../bootstrap/wiring/broll.ts";
import { legacySessionEffects } from "../js/12-dirty-toast.js";

export function appSessionDeps() {
  return { effects: legacySessionEffects(), editorName: getEditorName, refresh: runIdleRefresh, records: derivedRecordsPlan };
}
