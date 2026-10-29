import "./_production-tags-started.mjs";
import { getEditorName } from "../bootstrap/wiring/preferences-owner.ts";
import { wireTagProduction } from "../bootstrap/wiring/production-tags.ts";

import { derivedRecordsPlan } from "../bootstrap/wiring/broll.ts";
import { sessionEffects } from "../bootstrap/wiring/session-effects.ts";

export function appSessionDeps() {
  return { effects: sessionEffects(), editorName: getEditorName, refresh: wireTagProduction().refresh, records: derivedRecordsPlan };
}
