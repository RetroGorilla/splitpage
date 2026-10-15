import { getEditorName } from "../js/03-sync.js";
import { runIdleRefresh } from "../js/07-production-tags.js";
import { derivedRecordsPlan } from "../js/08c-broll.js";
import { legacySessionEffects } from "../js/12-dirty-toast.js";

export function appSessionDeps() {
  return { effects: legacySessionEffects(), editorName: getEditorName, refresh: runIdleRefresh, records: derivedRecordsPlan };
}
