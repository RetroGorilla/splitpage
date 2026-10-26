import { getEditorName } from "../legacy/preferences-bridge.ts";
import { runIdleRefresh } from "../js/07-production-tags.js";
import { derivedRecordsPlan } from "../bootstrap/wiring/broll.ts";
import { sessionEffects } from "../bootstrap/wiring/session-effects.ts";

export function appSessionDeps() {
  return { effects: sessionEffects(), editorName: getEditorName, refresh: runIdleRefresh, records: derivedRecordsPlan };
}
