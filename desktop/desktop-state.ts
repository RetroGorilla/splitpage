"use strict";

import type * as NodePath from "node:path";
import type * as NodeFs from "node:fs";
import type * as NodeCrypto from "node:crypto";
import type { Rectangle } from "electron";

const path: typeof NodePath = require("node:path");
const fs: typeof NodeFs = require("node:fs");
const crypto: typeof NodeCrypto = require("node:crypto");
const { writeFileDurableSync }: { writeFileDurableSync: (file: string, text: string) => void } = require("./drafts");

const DESKTOP_STATE_VERSION = 2;
const TAB_OR_WINDOW_ID_RE = /^[0-9a-f]{32}$/;
const LAST_KNOWN_TITLE_MAX = 300;
const RECENTS_MAX = 20;
const DESKTOP_STATE_TMP_RE = /^\.tmp-[0-9a-f]{12}-desktop-state\.json$/;

function mintTabOrWindowId() { return crypto.randomBytes(16).toString("hex"); }

function normalizeBounds(b: unknown): Rectangle | null {
  if (!b || typeof b !== "object") return null;
  const ok = ["x", "y", "width", "height"].every((k) => typeof (b as Record<string, unknown>)[k] === "number" && Number.isFinite((b as Record<string, unknown>)[k]));
  return ok ? { x: (b as Rectangle).x, y: (b as Rectangle).y, width: (b as Rectangle).width, height: (b as Rectangle).height } : null;
}

function normalizeTabSource(src: unknown): DesktopStoredTab["source"] {
  if (src && typeof src === "object") {
    if ((src as Record<string, unknown>).kind === "file" && typeof (src as Record<string, unknown>).absPath === "string" && (src as Record<string, unknown>).absPath && path.isAbsolute((src as { absPath: string }).absPath)) {
      return { kind: "file", absPath: (src as { absPath: string }).absPath };
    }
  }
  return { kind: "blank" };
}

function blankDesktopWindow(extra?: Partial<DesktopStoredWindow>): DesktopStoredWindow {
  const tabId = mintTabOrWindowId();
  return {
    windowId: mintTabOrWindowId(),
    bounds: null,
    maximized: false,
    activeTabId: tabId,
    tabs: [{ tabId, source: { kind: "blank" }, lastKnownTitle: "" }],
    ...(extra || {})
  };
}

function freshDesktopState(): DesktopStoredState {
  return { version: DESKTOP_STATE_VERSION, windows: [blankDesktopWindow()], recents: [] };
}

function migrateDesktopStateV1(v1: DesktopStateRaw): DesktopStoredState {
  const tabId = mintTabOrWindowId();
  const source: DesktopStoredTab["source"] = typeof v1.lastFilePath === "string" && v1.lastFilePath
    ? { kind: "file", absPath: v1.lastFilePath }
    : { kind: "blank" };
  return {
    version: DESKTOP_STATE_VERSION,
    windows: [{
      windowId: mintTabOrWindowId(),
      bounds: normalizeBounds(v1.windowBounds),
      maximized: v1.windowMaximized === true,
      activeTabId: tabId,
      tabs: [{ tabId, source, lastKnownTitle: "" }]
    }],
    recents: []
  };
}

function normalizeRecentsList(raw: unknown, pathKey: (path: string) => string): DesktopStoredState["recents"] {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw as DesktopStateRaw[] : []) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.absPath !== "string" || !r.absPath || !path.isAbsolute(r.absPath)) continue;
    const key = pathKey(r.absPath);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      absPath: r.absPath,
      title: typeof r.title === "string" ? r.title.slice(0, LAST_KNOWN_TITLE_MAX) : "",
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0
    });
    if (out.length >= RECENTS_MAX) break;
  }
  return out;
}

function normalizeDesktopStateV2(raw: unknown, pathKey: (path: string) => string): DesktopStoredState {
  const seen = new Set();
  const uniqueId = (id: unknown) => {
    const v = typeof id === "string" && TAB_OR_WINDOW_ID_RE.test(id) && !seen.has(id) ? id : mintTabOrWindowId();
    seen.add(v);
    return v;
  };
  const windows: DesktopStoredWindow[] = [];
  for (const w of Array.isArray(raw && (raw as DesktopStateRaw).windows) ? (raw as { windows: DesktopStateRaw[] }).windows : []) {
    if (!w || typeof w !== "object") continue;
    const tabs: DesktopStoredTab[] = [];
    for (const t of Array.isArray(w.tabs) ? w.tabs as DesktopStateRaw[] : []) {
      if (!t || typeof t !== "object") continue;
      tabs.push({
        tabId: uniqueId(t.tabId),
        source: normalizeTabSource(t.source),
        lastKnownTitle: typeof t.lastKnownTitle === "string" ? t.lastKnownTitle.slice(0, LAST_KNOWN_TITLE_MAX) : ""
      });
    }
    if (!tabs.length) continue;
    windows.push({
      windowId: uniqueId(w.windowId),
      bounds: normalizeBounds(w.bounds),
      maximized: w.maximized === true,
      activeTabId: tabs.some((t) => t.tabId === w.activeTabId) ? w.activeTabId as string : (tabs[0] as DesktopStoredTab).tabId,
      tabs
    });
  }
  const recents = normalizeRecentsList(raw && (raw as DesktopStateRaw).recents, pathKey);
  if (!windows.length) {
    const fresh = freshDesktopState();
    fresh.recents = recents;
    return fresh;
  }
  return { version: DESKTOP_STATE_VERSION, windows, recents };
}

function createDesktopStateStore({ filePath, pathKey, onWriteError }: {
  filePath: () => string;
  pathKey: (path: string) => string;
  onWriteError?: (error: unknown) => void;
}) {
  let synthesized: { text: string | null; state: DesktopStoredState } | null = null;
  const queue: { mutator: DesktopStateMutator; resolve: (written: boolean) => void }[] = [];
  let draining = false;

  function sweepTempFiles() {
    const dir = path.dirname(filePath());
    let names;
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (!DESKTOP_STATE_TMP_RE.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { }
    }
    return removed;
  }

  function read() {
    let text;
    try { text = fs.readFileSync(filePath(), "utf8"); } catch { text = null; }
    if (synthesized && synthesized.text === text) {
      return structuredClone(synthesized.state);
    }
    let parsed: unknown;
    try { parsed = text === null ? undefined : JSON.parse(text); } catch { parsed = undefined; }

    const isObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    const state = isObject && (parsed as DesktopStateRaw).version === DESKTOP_STATE_VERSION ? normalizeDesktopStateV2(parsed, pathKey)
      : isObject && !("version" in (parsed as DesktopStateRaw)) ? migrateDesktopStateV1(parsed as DesktopStateRaw)
      : freshDesktopState();
    synthesized = { text, state: structuredClone(state) };
    return state;
  }

  function write(mutator: DesktopStateMutator) {
    return new Promise<boolean>((resolve) => {
      queue.push({ mutator, resolve });
      if (!draining) drain();
    });
  }

  function drain() {
    draining = true;
    try {
      while (queue.length) {
        const job = queue.shift() as (typeof queue)[number];
        let written = false;
        try {
          const current = read();
          const result = job.mutator(current);
          if (result !== false) {
            const next = normalizeDesktopStateV2(result && typeof result === "object" ? result : current, pathKey);
            const file = filePath();
            const text = JSON.stringify(next, null, 2);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            writeFileDurableSync(file, text);
            synthesized = null;
            written = true;
          }
        } catch (err) {
          if (onWriteError) onWriteError(err);
        }
        job.resolve(written);
      }
    } finally {
      draining = false;
    }
  }

  return { read, write, sweepTempFiles };
}


type DesktopStateRaw = Record<string, unknown>;
export interface DesktopStoredTab {
  tabId: string;
  source: { kind: "blank" } | { kind: "file"; absPath: string };
  lastKnownTitle: string;
}
export interface DesktopStoredWindow {
  windowId: string;
  bounds: Rectangle | null;
  maximized: boolean;
  activeTabId: string;
  tabs: DesktopStoredTab[];
}
export interface DesktopStoredState {
  version: number;
  windows: DesktopStoredWindow[];
  recents: { absPath: string; title: string; at: number }[];
}
type DesktopStateMutator = (state: DesktopStoredState) => unknown;
export type {
  DESKTOP_STATE_VERSION, TAB_OR_WINDOW_ID_RE, LAST_KNOWN_TITLE_MAX, RECENTS_MAX,
  mintTabOrWindowId, normalizeBounds, normalizeTabSource, blankDesktopWindow,
  freshDesktopState, migrateDesktopStateV1, normalizeRecentsList, normalizeDesktopStateV2,
  createDesktopStateStore
};

module.exports = {
  DESKTOP_STATE_VERSION,
  TAB_OR_WINDOW_ID_RE,
  LAST_KNOWN_TITLE_MAX,
  RECENTS_MAX,
  mintTabOrWindowId,
  normalizeBounds,
  normalizeTabSource,
  blankDesktopWindow,
  freshDesktopState,
  migrateDesktopStateV1,
  normalizeRecentsList,
  normalizeDesktopStateV2,
  createDesktopStateStore
};
