import type { KeyValueStorage } from "../recovery/conflict-stash.ts";

const WIDTHS_KEY = "splitpage-panel-widths";
const LEGACY_COMMENTS_KEY = "splitpage-comments-panel-width";
const WIDTH_MIN = 280;
const WIDTH_MAX = 720;
const WIDTH_DEFAULT = 488;

export const SIDE_PANEL_IDS: readonly string[] = Object.freeze([
  "comments-panel",
  "production-panel",
  "gear-panel",
  "broll-panel",
  "history-panel"
]);

export interface PanelWidthPorts {
  readonly storage: () => KeyValueStorage | null | undefined;
}

export interface PanelWidths {
  readonly defaultWidth: (id: string) => number;
  readonly clamp: (width: number, id: string) => number;
  readonly read: (id: string) => number;
  readonly save: (id: string, width: number) => void;
}

export function createPanelWidths(ports: PanelWidthPorts): PanelWidths {
  function stored(key: string): string | null {
    try {
      const value = ports.storage()?.getItem(key);
      return typeof value === "string" ? value : null;
    } catch (e) { return null; }
  }

  function defaultWidth(): number { return WIDTH_DEFAULT; }

  function clamp(width: number): number {
    if (!isFinite(width)) return WIDTH_DEFAULT;
    return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(width)));
  }

  function widthMap(): Record<string, unknown> {
    const raw = stored(WIDTHS_KEY);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch (e) { return {}; }
  }

  return Object.freeze({
    defaultWidth: defaultWidth,
    clamp: clamp,
    read: function (id: string): number {
      const map = widthMap();
      if (Object.prototype.hasOwnProperty.call(map, id)) {
        const w = parseFloat(String(map[id]));
        return isFinite(w) ? clamp(w) : WIDTH_DEFAULT;
      }
      if (id === "comments-panel") {
        const legacy = parseFloat(stored(LEGACY_COMMENTS_KEY) ?? "");
        if (isFinite(legacy)) return clamp(legacy);
      }
      return WIDTH_DEFAULT;
    },
    save: function (id: string, width: number): void {
      const map = widthMap();
      map[id] = clamp(width);
      try { ports.storage()?.setItem(WIDTHS_KEY, JSON.stringify(map)); } catch (e) { }
    }
  });
}
