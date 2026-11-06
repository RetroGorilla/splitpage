export interface MicrophoneOption {
  readonly id: string;
  readonly label: string;
}

export interface MicrophoneList {
  readonly options: readonly MicrophoneOption[];
  readonly named: boolean;
}

export type MicrophoneSupport = "yes" | "desktop" | "relay" | "browser";

export interface MicrophoneDevices {
  readonly support: () => MicrophoneSupport;
  readonly list: () => Promise<MicrophoneList>;
  readonly onChange: (listener: () => void) => () => void;
}

export interface MicrophoneChoice {
  readonly value: string;
  readonly label: string;
}

export interface BrowserBrand {
  readonly brand: string;
  readonly version: string;
}

export const SYSTEM_DEFAULT_MICROPHONE = "System default";
export const MISSING_MICROPHONE = "Saved microphone (not connected)";
export const UNNAMED_MICROPHONE = "Saved microphone";

const FIRST_CHROMIUM_WITH_TRACK_RECOGNITION = 135;
const DESKTOP_PLATFORMS: readonly string[] = Object.freeze(["Windows", "macOS", "Linux"]);
const VIRTUAL_ENTRIES: readonly string[] = Object.freeze(["default", "communications"]);

export function isDesktopMicrophoneId(id: string): boolean {
  return /^\{0\.0\.1\.00000000\}\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i.test(id);
}

export function recognitionTakesTrack(brands: readonly BrowserBrand[] | undefined, platform: string | undefined): boolean {
  const chromium = (brands ?? []).find((entry) => entry.brand === "Chromium");
  return !!chromium && parseInt(chromium.version, 10) >= FIRST_CHROMIUM_WITH_TRACK_RECOGNITION &&
    DESKTOP_PLATFORMS.indexOf(platform ?? "") !== -1;
}

export function microphoneList(found: readonly { readonly deviceId: string; readonly label: string }[]): MicrophoneList {
  const options: MicrophoneOption[] = [];
  found.forEach(function (entry) {
    if (!entry.deviceId || VIRTUAL_ENTRIES.indexOf(entry.deviceId) !== -1) return;
    options.push({ id: entry.deviceId, label: entry.label || "Microphone " + (options.length + 1) });
  });
  return { options, named: found.some((entry) => !!entry.deviceId && !!entry.label) };
}

export function microphoneChoices(saved: string, list: MicrophoneList): readonly MicrophoneChoice[] {
  const choices: MicrophoneChoice[] = [{ value: "", label: SYSTEM_DEFAULT_MICROPHONE }];
  list.options.forEach(function (option) { choices.push({ value: option.id, label: option.label }); });
  if (saved && !list.options.some((option) => option.id === saved)) {
    choices.push({ value: saved, label: list.named ? MISSING_MICROPHONE : UNNAMED_MICROPHONE });
  }
  return choices;
}
