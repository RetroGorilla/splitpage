import { cappedLongText } from "../../core/document/text-policy.ts";
import type { KeyValueStorage } from "../recovery/conflict-stash.ts";

export const WRITER_SIZE_MIN = 16;
export const WRITER_SIZE_MAX = 34;

const KEYS = Object.freeze({
  autosave: "splitpage-autosave",
  commentAuthor: "splitpage-comment-author",
  hideShot: "splitpage-hide-shot",
  onboarding: "splitpage-onboarding",
  taggingHelp: "splitpage-tagging-help-dismissed",
  tourDone: "splitpage-tour-done",
  writerSize: "splitpage-writer-size"
});

export type PreferenceName = keyof typeof KEYS;

export interface PreferenceChange {
  readonly key: string;
  readonly value: string | null;
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
  readonly autosave: () => boolean;
  readonly setAutosave: (on: boolean) => void;
  readonly commentAuthor: () => string;
  readonly setCommentAuthor: (name: string) => void;
  readonly rememberCommentAuthor: (name: string) => void;
  readonly hideShot: () => boolean;
  readonly setHideShot: (on: boolean) => void;
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
  readonly appDataExport: (extra: readonly AppDataPref[]) => Record<string, unknown>;
  readonly appDataImport: (incoming: unknown, extra: readonly AppDataPref[]) => string[];
}

function isFlag(value: string): boolean {
  return value === "0" || value === "1";
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
    { name: "autosave", key: KEYS.autosave, valid: isFlag }
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

  return Object.freeze({
    nameOf: function (key: string): PreferenceName | null { return names.get(key) ?? null; },
    autosave: function (): boolean { return read(KEYS.autosave) !== "0"; },
    setAutosave: function (on: boolean): void { announce(KEYS.autosave, on ? "1" : "0"); },
    commentAuthor: function (): string { return read(KEYS.commentAuthor) ?? ""; },
    setCommentAuthor: function (name: string): void { announce(KEYS.commentAuthor, name); },
    rememberCommentAuthor: function (name: string): void { put(KEYS.commentAuthor, name); },
    hideShot: function (): boolean { return read(KEYS.hideShot) === "1"; },
    setHideShot: function (on: boolean): void { announce(KEYS.hideShot, on ? "1" : "0"); },
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
    appDataExport: function (extra: readonly AppDataPref[]): Record<string, unknown> {
      const out: Record<string, unknown> = { onboarding: readJson(KEYS.onboarding) ?? null };
      ownAppData().concat(extra).forEach(function (spec) { out[spec.name] = read(spec.key); });
      return out;
    },
    appDataImport: function (incoming: unknown, extra: readonly AppDataPref[]): string[] {
      const prefs = isPlainObject(incoming) ? incoming : {};
      const written: string[] = [];
      ownAppData().concat(extra).forEach(function (spec) {
        const value = prefs[spec.name];
        if (typeof value !== "string" || !spec.valid(value)) return;
        if (read(spec.key) !== null) return;
        if (put(spec.key, value)) written.push(spec.name);
      });
      if (mergeOnboarding(prefs["onboarding"])) written.push("onboarding");
      return written;
    }
  });
}
