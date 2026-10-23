import { onHistoryChange } from "../../js/03a-history-store.js";
import { renderHistory } from "../../js/03-sync.js";
import { onPreferenceChange, preferences } from "../../legacy/preferences-bridge.ts";

function historyChanged(): void {
  try {
    void renderHistory().catch(() => {});
  } catch (error) {
    if (window.console) console.error(error);
  }
}

export function listenHistory(): () => void {
  const stops = [
    onHistoryChange(historyChanged),
    onPreferenceChange((change) => {
      if (preferences().nameOf(change.key) === "clock") historyChanged();
    })
  ];
  return () => { stops.forEach((stop) => stop()); };
}
