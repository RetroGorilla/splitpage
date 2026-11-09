import { paletteColor } from "../../core/document/person-colors.ts";
import { cappedLongText } from "../../core/document/text-policy.ts";
import type { KeyValueStorage } from "../recovery/conflict-stash.ts";

export const WRITER_SIZE_MIN = 16;
export const WRITER_SIZE_MAX = 34;
export const SCRIPT_SCALE_MIN = 0.7;
export const SCRIPT_SCALE_MAX = 2;
export const CLOCK_MODES: readonly string[] = Object.freeze(["system", "12", "24"]);
export const THEME_MODES: readonly string[] = Object.freeze(["system", "light", "dark"]);
const MICROPHONE_ID_MAX = 512;
export const BROLL_VIEW_KEY = "splitpage-broll-view";

const KEYS = Object.freeze({
  autosave: "splitpage-autosave",
  clock: "splitpage-clock",
  commentAuthor: "splitpage-comment-author",
  commentsSort: "splitpage-comments-sort",
  commentFilter: "splitpage-comments-filter",
  defaultWpm: "splitpage-default-wpm",
  desktopNotice: "splitpage-desktop-notice-dismissed",
  exportDirections: "splitpage-export-directions",
  hideShot: "splitpage-hide-shot",
  microphone: "splitpage-microphone",
  onboarding: "splitpage-onboarding",
  panelGrouping: "splitpage-panel-grouping",
  personColor: "splitpage-person-color",
  prompterFlip: "splitpage-prompter-flip",
  prompterMirror: "splitpage-prompter-mirror",
  prompterSceneMode: "splitpage-prompter-scene-mode",
  rundownMin: "splitpage-rundown-min",
  scriptScale: "splitpage-script-scale",
  tagIcons: "splitpage-tag-icons",
  taggingHelp: "splitpage-tagging-help-dismissed",
  theme: "splitpage-theme",
  tourDone: "splitpage-tour-done",
  videoThumbs: "splitpage-video-thumbs",
  writerSize: "splitpage-writer-size"
});

const COMMENTS_FILTER_LEGACY_KEY = "splitpage-comments-hide-resolved";

export interface CommentFilter {
  mode: string;
  assignee: string;
}

export type GroupingPanel = "broll" | "production" | "gear";
export type PanelGroupingPreferences = Partial<Record<GroupingPanel, string>>;

export type PreferenceName = keyof typeof KEYS;

export type PrompterFlag = "prompterMirror" | "prompterFlip" | "prompterSceneMode";

export interface PreferenceChange {
  readonly key: string;
  readonly value: string | null;
}

export interface PreferenceNotice {
  readonly name: PreferenceName;
  readonly value: string | null;
  readonly elsewhere: boolean;
}

export interface PreferenceHearing {
  readonly elsewhere?: boolean;
}

export interface PreferenceChanges {
  readonly onChange: (listener: (change: PreferenceNotice) => void, hearing?: PreferenceHearing) => () => void;
}

export interface PreferencePorts {
  readonly storage: () => KeyValueStorage | null | undefined;
  readonly announce: (change: PreferenceChange) => void;
}

export interface AppDataPref {
  readonly name: string;
  readonly key: string;
  readonly valid: (value: string) => boolean;
}

export type OnboardingRecord = Record<string, unknown>;

export interface Preferences {
  readonly nameOf: (key: string) => PreferenceName | null;
  readonly panelGrouping: (panel: GroupingPanel) => string | null;
  readonly setPanelGrouping: (panel: GroupingPanel, mode: string) => void;
  readonly autosave: () => boolean;
  readonly setAutosave: (on: boolean) => void;
  readonly commentAuthor: () => string;
  readonly setCommentAuthor: (name: string) => void;
  readonly rememberCommentAuthor: (name: string) => void;
  readonly commentsSort: () => "recent" | "position" | "by-scene";
  readonly setCommentsSort: (mode: string) => void;
  readonly commentFilter: () => CommentFilter;
  readonly setCommentFilter: (filter: CommentFilter) => void;
  readonly hideShot: () => boolean;
  readonly setHideShot: (on: boolean) => void;
  readonly microphone: () => string;
  readonly setMicrophone: (id: string) => void;
  readonly taggingHelpShown: () => void;
  readonly taggingHelpDismissed: () => void;
  readonly announceTaggingHelp: () => void;
  readonly tourFinished: () => void;
  readonly resetTour: () => void;
  readonly onboarding: () => OnboardingRecord | null;
  readonly recordOnboarding: (skipped: boolean, at: string) => void;
  readonly skipOnboardingForPrompter: () => void;
  readonly writerSize: () => number | null;
  readonly setWriterSize: (px: number) => void;
  readonly clock: () => string;
  readonly setClock: (mode: string) => void;
  readonly theme: () => string;
  readonly setTheme: (mode: string) => void;
  readonly myColor: () => string;
  readonly setMyColor: (color: string | null) => void;
  readonly defaultWpm: () => number;
  readonly setDefaultWpm: (wpm: number) => void;
  readonly rundownMin: () => boolean;
  readonly setRundownMin: (on: boolean) => void;
  readonly tagIcons: () => boolean;
  readonly setTagIcons: (on: boolean) => void;
  readonly videoThumbs: () => boolean;
  readonly setVideoThumbs: (on: boolean) => void;
  readonly scriptScale: () => number;
  readonly setScriptScale: (scale: number) => void;
  readonly clearScriptScale: () => void;
  readonly prompterFlag: (name: PrompterFlag) => boolean;
  readonly setPrompterFlag: (name: PrompterFlag, on: boolean) => void;
  readonly desktopNoticeDismissed: () => boolean;
  readonly dismissDesktopNotice: () => void;
  readonly resetDesktopNotice: () => void;
  readonly exportDirections: () => boolean;
  readonly setExportDirections: (on: boolean) => void;
  readonly appDataExport: (extra: readonly AppDataPref[]) => Record<string, unknown>;
  readonly appDataImport: (incoming: unknown, extra: readonly AppDataPref[]) => string[];
}

function isFlag(value: string): boolean {
  return value === "0" || value === "1";
}

function inRangeWpm(value: string): boolean {
  const n = /^\d{2,3}$/.test(value) ? parseInt(value, 10) : NaN;
  return n >= 60 && n <= 400;
}

function isScriptScale(value: string): boolean {
  const n = Number(value);
  return /^\d(\.\d{1,3})?$/.test(value) && n >= SCRIPT_SCALE_MIN && n <= SCRIPT_SCALE_MAX;
}

export function settingsAppData(): readonly AppDataPref[] {
  return [
    { name: "theme", key: KEYS.theme, valid: function (v: string) { return THEME_MODES.indexOf(v) !== -1; } },
    { name: "clock", key: KEYS.clock, valid: function (v: string) { return CLOCK_MODES.indexOf(v) !== -1; } },
    { name: "personColor", key: KEYS.personColor, valid: function (v: string) { return !!paletteColor(v); } },
    { name: "defaultWpm", key: KEYS.defaultWpm, valid: inRangeWpm },
    { name: "hideShot", key: KEYS.hideShot, valid: isFlag },
    { name: "prompterMirror", key: KEYS.prompterMirror, valid: isFlag },
    { name: "prompterFlip", key: KEYS.prompterFlip, valid: isFlag },
    { name: "prompterSceneMode", key: KEYS.prompterSceneMode, valid: isFlag },
    { name: "rundownMin", key: KEYS.rundownMin, valid: isFlag },
    { name: "videoThumbs", key: KEYS.videoThumbs, valid: isFlag },
    { name: "tagIcons", key: KEYS.tagIcons, valid: isFlag },
    { name: "scriptScale", key: KEYS.scriptScale, valid: isScriptScale }
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ownAppData(): readonly AppDataPref[] {
  return [
    { name: "tourDone", key: KEYS.tourDone, valid: function (v: string) { return v.length > 0 && v.length <= 20; } },
    { name: "commentAuthor", key: KEYS.commentAuthor, valid: function (v: string) { return v.trim().length > 0 && v.length <= 200; } },
    {
      name: "writerSize",
      key: KEYS.writerSize,
      valid: function (v: string) {
        const n = /^\d{1,3}$/.test(v) ? parseInt(v, 10) : NaN;
        return n >= WRITER_SIZE_MIN && n <= WRITER_SIZE_MAX;
      }
    },
    { name: "taggingHelpDismissed", key: KEYS.taggingHelp, valid: isFlag },
    { name: "autosave", key: KEYS.autosave, valid: isFlag },
    { name: "commentsSort", key: KEYS.commentsSort, valid: function (v: string) { return v === "recent" || v === "position" || v === "by-scene"; } },
    { name: "panelGrouping", key: KEYS.panelGrouping, valid: function (v: string) {
      try {
        const value: unknown = JSON.parse(v);
        return isPlainObject(value) && Object.entries(value).every(([key, mode]) =>
          ["broll", "comments", "production", "gear"].includes(key) && typeof mode === "string" && mode.length <= 40);
      } catch { return false; }
    } }
  ];
}

function cleanOnboarding(incoming: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  let n = 0;
  Object.keys(incoming).forEach(function (k) {
    const v = incoming[k];
    if (n >= 20 || k === "__proto__" || k.length > 40) return;
    if (typeof v === "string") { clean[k] = cappedLongText(v, 200); n++; }
    else if (typeof v === "boolean" || (typeof v === "number" && isFinite(v))) { clean[k] = v; n++; }
  });
  return clean;
}

export function createPreferences(ports: PreferencePorts): Preferences {
  const names = new Map<string, PreferenceName>();
  (Object.keys(KEYS) as PreferenceName[]).forEach(function (name) { names.set(KEYS[name], name); });

  function read(key: string): string | null {
    try {
      const found = ports.storage();
      if (!found) return null;
      const value = found.getItem(key);
      return typeof value === "string" ? value : null;
    } catch (e) { return null; }
  }

  function put(key: string, value: string | null): boolean {
    try {
      const found = ports.storage();
      if (!found) return false;
      if (value === null) found.removeItem(key);
      else found.setItem(key, value);
      return true;
    } catch (e) { return false; }
  }

  function announce(key: string, value: string | null): void {
    put(key, value);
    try { ports.announce({ key: key, value: value }); } catch (e) { }
  }

  function notify(key: string, value: string | null): void {
    try { ports.announce({ key, value }); } catch (e) { }
  }

  function readJson(key: string): unknown {
    const raw = read(key);
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch (e) { return undefined; }
  }

  function mergeOnboarding(incoming: unknown): boolean {
    if (!isPlainObject(incoming)) return false;
    const clean = cleanOnboarding(incoming);
    const added = Object.keys(clean);
    const raw = read(KEYS.onboarding);
    const local = raw === null ? null : readJson(KEYS.onboarding);
    if (!added.length || !(raw === null || isPlainObject(local))) return false;
    const merged: Record<string, unknown> = {};
    let changed = raw === null;
    added.forEach(function (k) { merged[k] = clean[k]; });
    if (isPlainObject(local)) {
      Object.keys(local).forEach(function (k) {
        if (k !== "__proto__") merged[k] = local[k];
      });
      added.forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(local, k)) changed = true;
      });
    }
    return changed && put(KEYS.onboarding, JSON.stringify(merged));
  }

  function migrateCommentsGrouping(): void {
    const local = readJson(KEYS.panelGrouping);
    if (!isPlainObject(local) || !Object.hasOwn(local, "comments")) return;
    const mode = local["comments"];
    if (read(KEYS.commentsSort) === null && (mode === "position" || mode === "recent" || mode === "by-scene")) {
      if (!put(KEYS.commentsSort, mode)) return;
    }
    const rest = { ...local };
    delete rest["comments"];
    put(KEYS.panelGrouping, Object.keys(rest).length ? JSON.stringify(rest) : null);
  }

  function migrateBrollGrouping(): void {
    const view = readJson(BROLL_VIEW_KEY);
    if (!isPlainObject(view) || !Object.hasOwn(view, "group")) return;
    const mode = view["group"];
    if (mode !== "scene" && mode !== "location" && mode !== "flat" && mode !== "by-scene") return;
    const raw = read(KEYS.panelGrouping);
    const local = raw === null ? {} : readJson(KEYS.panelGrouping);
    if (!isPlainObject(local)) return;
    if (!Object.hasOwn(local, "broll") && !put(KEYS.panelGrouping, JSON.stringify({ ...local, broll: mode }))) return;
    const rest = { ...view };
    delete rest["group"];
    put(BROLL_VIEW_KEY, JSON.stringify(rest));
  }

  function mergePanelGrouping(incoming: unknown): boolean {
    if (typeof incoming !== "string") return false;
    const spec = ownAppData().find(item => item.name === "panelGrouping");
    if (!spec?.valid(incoming)) return false;
    const added: unknown = JSON.parse(incoming);
    if (!isPlainObject(added)) return false;
    const raw = read(KEYS.panelGrouping);
    const local = raw === null ? {} : readJson(KEYS.panelGrouping);
    if (!isPlainObject(local)) return false;
    const merged: Record<string, unknown> = { ...local };
    let changed = false;
    for (const key of ["broll", "production", "gear"] as const) {
      if (typeof added[key] !== "string" || Object.hasOwn(local, key)) continue;
      merged[key] = added[key];
      changed = true;
    }
    return changed && put(KEYS.panelGrouping, JSON.stringify(merged));
  }

  return Object.freeze({
    nameOf: function (key: string): PreferenceName | null { return names.get(key) ?? null; },
    panelGrouping: function (panel: GroupingPanel): string | null {
      migrateCommentsGrouping();
      migrateBrollGrouping();
      const value = readJson(KEYS.panelGrouping);
      return isPlainObject(value) && typeof value[panel] === "string" ? value[panel] : null;
    },
    setPanelGrouping: function (panel: GroupingPanel, mode: string): void {
      migrateCommentsGrouping();
      migrateBrollGrouping();
      const value = readJson(KEYS.panelGrouping);
      const saved: PanelGroupingPreferences = {};
      for (const key of ["broll", "production", "gear"] as const) {
        if (isPlainObject(value) && typeof value[key] === "string") saved[key] = value[key];
      }
      saved[panel] = mode;
      announce(KEYS.panelGrouping, JSON.stringify(saved));
    },
    autosave: function (): boolean { return read(KEYS.autosave) !== "0"; },
    setAutosave: function (on: boolean): void { announce(KEYS.autosave, on ? "1" : "0"); },
    commentAuthor: function (): string { return read(KEYS.commentAuthor) ?? ""; },
    setCommentAuthor: function (name: string): void { announce(KEYS.commentAuthor, name); },
    rememberCommentAuthor: function (name: string): void {
      if (read(KEYS.commentAuthor) !== name) announce(KEYS.commentAuthor, name);
    },
    commentsSort: function (): "recent" | "position" | "by-scene" {
      migrateCommentsGrouping();
      const value = read(KEYS.commentsSort);
      return value === "recent" || value === "by-scene" ? value : "position";
    },
    setCommentsSort: function (mode: string): void { migrateCommentsGrouping(); announce(KEYS.commentsSort, mode === "recent" || mode === "by-scene" ? mode : "position"); },
    commentFilter: function (): CommentFilter {
      try {
        const raw = read(KEYS.commentFilter);
        if (raw) {
          const value: unknown = JSON.parse(raw);
          if (value && typeof value === "object") {
            const parsed = value as Record<string, unknown>;
            const modes: Record<string, boolean> = { open: true, resolved: true, all: true };
            const mode = parsed["mode"];
            return {
              mode: typeof mode === "string" && modes[mode] ? mode : "open",
              assignee: typeof parsed["assignee"] === "string" ? parsed["assignee"] : ""
            };
          }
        }
        const legacy = read(COMMENTS_FILTER_LEGACY_KEY);
        if (legacy !== null) return { mode: legacy === "true" ? "open" : "all", assignee: "" };
      } catch (e) { }
      return { mode: "open", assignee: "" };
    },
    setCommentFilter: function (filter: CommentFilter): void { announce(KEYS.commentFilter, JSON.stringify(filter)); },
    hideShot: function (): boolean { return read(KEYS.hideShot) === "1"; },
    setHideShot: function (on: boolean): void { announce(KEYS.hideShot, on ? "1" : "0"); },
    microphone: function (): string {
      const id = read(KEYS.microphone) ?? "";
      return id.length <= MICROPHONE_ID_MAX ? id : "";
    },
    setMicrophone: function (id: string): void { announce(KEYS.microphone, id && id.length <= MICROPHONE_ID_MAX ? id : null); },
    taggingHelpShown: function (): void { put(KEYS.taggingHelp, "0"); },
    taggingHelpDismissed: function (): void { put(KEYS.taggingHelp, "1"); },
    announceTaggingHelp: function (): void { announce(KEYS.taggingHelp, read(KEYS.taggingHelp)); },
    tourFinished: function (): void { put(KEYS.tourDone, "1"); },
    resetTour: function (): void { announce(KEYS.tourDone, null); },
    onboarding: function (): OnboardingRecord | null {
      const parsed = readJson(KEYS.onboarding);
      return parsed && typeof parsed === "object" ? parsed as OnboardingRecord : null;
    },
    recordOnboarding: function (skipped: boolean, at: string): void {
      put(KEYS.onboarding, JSON.stringify({ v: 1, done: true, skipped: skipped, at: at }));
    },
    skipOnboardingForPrompter: function (): void {
      if (!read(KEYS.onboarding)) {
        put(KEYS.onboarding, JSON.stringify({ v: 1, done: true, skipped: true, at: "prompter-launch" }));
      }
    },
    writerSize: function (): number | null {
      const n = parseInt(read(KEYS.writerSize) ?? "", 10);
      return isFinite(n) ? Math.min(WRITER_SIZE_MAX, Math.max(WRITER_SIZE_MIN, n)) : null;
    },
    setWriterSize: function (px: number): void { announce(KEYS.writerSize, String(px)); },
    clock: function (): string {
      const v = read(KEYS.clock);
      return v !== null && CLOCK_MODES.indexOf(v) !== -1 ? v : "system";
    },
    setClock: function (mode: string): void { announce(KEYS.clock, mode === "system" ? null : mode); },
    theme: function (): string {
      const v = read(KEYS.theme);
      return v !== null && THEME_MODES.indexOf(v) !== -1 ? v : "system";
    },
    setTheme: function (mode: string): void { announce(KEYS.theme, mode === "system" ? null : mode); },
    myColor: function (): string { return paletteColor(read(KEYS.personColor)); },
    setMyColor: function (color: string | null): void { announce(KEYS.personColor, color); },
    defaultWpm: function (): number {
      const n = parseInt(read(KEYS.defaultWpm) ?? "", 10);
      return isFinite(n) && n >= 60 && n <= 400 ? n : 150;
    },
    setDefaultWpm: function (wpm: number): void { announce(KEYS.defaultWpm, wpm === 150 ? null : String(wpm)); },
    rundownMin: function (): boolean { return read(KEYS.rundownMin) === "1"; },
    setRundownMin: function (on: boolean): void { announce(KEYS.rundownMin, on ? "1" : "0"); },
    tagIcons: function (): boolean { return read(KEYS.tagIcons) === "1"; },
    setTagIcons: function (on: boolean): void { announce(KEYS.tagIcons, on ? "1" : null); },
    videoThumbs: function (): boolean { return read(KEYS.videoThumbs) !== "0"; },
    setVideoThumbs: function (on: boolean): void { announce(KEYS.videoThumbs, on ? null : "0"); },
    scriptScale: function (): number {
      const n = Number(read(KEYS.scriptScale));
      return isFinite(n) && n >= SCRIPT_SCALE_MIN && n <= SCRIPT_SCALE_MAX ? n : 1;
    },
    setScriptScale: function (scale: number): void { announce(KEYS.scriptScale, String(Math.round(scale * 100) / 100)); },
    clearScriptScale: function (): void { announce(KEYS.scriptScale, null); },
    prompterFlag: function (name: PrompterFlag): boolean { return read(KEYS[name]) === "1"; },
    setPrompterFlag: function (name: PrompterFlag, on: boolean): void { announce(KEYS[name], on ? "1" : "0"); },
    desktopNoticeDismissed: function (): boolean { return read(KEYS.desktopNotice) === "1"; },
    dismissDesktopNotice: function (): void { announce(KEYS.desktopNotice, "1"); },
    resetDesktopNotice: function (): void { announce(KEYS.desktopNotice, null); },
    exportDirections: function (): boolean { return read(KEYS.exportDirections) !== "0"; },
    setExportDirections: function (on: boolean): void { announce(KEYS.exportDirections, on ? null : "0"); },
    appDataExport: function (extra: readonly AppDataPref[]): Record<string, unknown> {
      const out: Record<string, unknown> = { onboarding: readJson(KEYS.onboarding) ?? null };
      ownAppData().concat(extra).forEach(function (spec) { out[spec.name] = read(spec.key); });
      return out;
    },
    appDataImport: function (incoming: unknown, extra: readonly AppDataPref[]): string[] {
      const prefs = isPlainObject(incoming) ? incoming : {};
      const written: string[] = [];
      migrateCommentsGrouping();
      migrateBrollGrouping();
      ownAppData().concat(extra).forEach(function (spec) {
        if (spec.name === "panelGrouping") return;
        const value = prefs[spec.name];
        if (typeof value !== "string" || !spec.valid(value)) return;
        if (read(spec.key) !== null) return;
        if (put(spec.key, value)) {
          written.push(spec.name);
          if (spec.name === "commentsSort") notify(spec.key, value);
        }
      });
      const grouping = prefs["panelGrouping"];
      if (typeof grouping === "string") {
        const spec = ownAppData().find(item => item.name === "panelGrouping");
        if (spec?.valid(grouping)) {
          const parsed: unknown = JSON.parse(grouping);
          const mode = isPlainObject(parsed) ? parsed["comments"] : null;
          if (read(KEYS.commentsSort) === null && (mode === "position" || mode === "recent" || mode === "by-scene") && put(KEYS.commentsSort, mode)) {
            written.push("commentsSort");
            notify(KEYS.commentsSort, mode);
          }
        }
      }
      if (mergePanelGrouping(grouping)) {
        written.push("panelGrouping");
        notify(KEYS.panelGrouping, read(KEYS.panelGrouping));
      }
      if (mergeOnboarding(prefs["onboarding"])) written.push("onboarding");
      return written;
    }
  });
}
