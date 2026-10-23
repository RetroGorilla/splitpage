import { PREF_EVENT, notePreferenceChange } from "../../legacy/preferences-bridge.ts";
import type { PreferenceChange } from "../../application/preferences/preferences.ts";

let stopWatch: (() => void) | null = null;

export function mountPreferenceWatchFeature(): void {
  stopPreferenceWatchFeature();
  function announced(e: Event): void {
    const detail = (e as CustomEvent<Partial<PreferenceChange> | null>).detail;
    if (detail && typeof detail.key === "string") notePreferenceChange({ key: detail.key, value: detail.value ?? null });
  }
  function stored(e: StorageEvent): void {
    if (e.key !== null) notePreferenceChange({ key: e.key, value: e.newValue });
  }
  document.addEventListener(PREF_EVENT, announced);
  window.addEventListener("storage", stored);
  stopWatch = () => {
    document.removeEventListener(PREF_EVENT, announced);
    window.removeEventListener("storage", stored);
  };
}

export function stopPreferenceWatchFeature(): void {
  const stop = stopWatch;
  stopWatch = null;
  stop?.();
}
