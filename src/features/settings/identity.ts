import { updateIdentityChip } from "../../js/03-sync.js";
import { onPreferenceChange, preferences } from "../../legacy/preferences-bridge.ts";

export function listenIdentity(): () => void {
  return onPreferenceChange((change) => {
    const name = preferences().nameOf(change.key);
    if (name === "commentAuthor" || name === "personColor") updateIdentityChip();
  });
}
