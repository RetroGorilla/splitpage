import { createSessionEffects } from "../../application/save/session-effects.ts";
import type { SessionEffects } from "../../application/save/session-effects.ts";
import { homes } from "./ports/location.ts";
import { attributionPreferences } from "./ports/preferences.ts";
import { saveChangeNotes, saves } from "./ports/saving.ts";
import { draftChanges } from "./ports/startup.ts";

export function sessionEffects(): SessionEffects {
  return createSessionEffects({
    saves,
    changes: saveChangeNotes,
    drafts: draftChanges,
    location: homes,
    preferences: attributionPreferences
  });
}
