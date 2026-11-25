"use strict";

import type * as NodePath from "node:path";
import type * as NodeFs from "node:fs";
import type * as NodeCrypto from "node:crypto";
import type { DesktopSharedScriptReference } from "../shared/desktop-contract.d.ts";
import type { Rectangle } from "electron";
import type { writeFileDurableSync as WriteDesktopStateFile } from "./drafts.ts";
import type { SharedScriptCatalogueEntry, SharedScriptIdentity, readSharedScriptCatalogueEntry, readSharedScriptIdentity } from "../shared/shared-script.ts";
import type { SharedFileRecord } from "../shared/shared-file-copy.d.ts";

const path: typeof NodePath = require("node:path");
const fs: typeof NodeFs = require("node:fs");
const crypto: typeof NodeCrypto = require("node:crypto");
const { writeFileDurableSync }: { writeFileDurableSync: typeof WriteDesktopStateFile } = require("./drafts.ts");

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

function normalizeTabSource(src: unknown, readShared?: typeof readSharedScriptIdentity): DesktopStoredTab["source"] {
  if (src && typeof src === "object") {
    if ((src as Record<string, unknown>).kind === "file" && typeof (src as Record<string, unknown>).absPath === "string" && (src as Record<string, unknown>).absPath && path.isAbsolute((src as { absPath: string }).absPath)) {
      return { kind: "file", absPath: (src as { absPath: string }).absPath };
    }
    if ((src as DesktopStateRaw).kind === "shared") {
      const shared = readShared?.(src);
      if (shared) return { kind: "shared", ...shared };
    }
  }
  return { kind: "blank" };
}

function normalizeSharedReference(value: unknown): DesktopSharedScriptReference | null {
  if (!value || typeof value !== "object") return null;
  const { deployment, script, address } = value as Partial<DesktopSharedScriptReference>;
  const id = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
  if (typeof deployment !== "string" || !id.test(deployment) || typeof script !== "string" || !id.test(script)
    || typeof address !== "string" || address.length > 2048) return null;
  try {
    const url = new URL(address);
    if (url.origin !== address || !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1")) return null;
    return { deployment, script, address };
  } catch { return null; }
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

function normalizeDesktopStateV2(raw: unknown, pathKey: (path: string) => string, shared?: DesktopSharedStateReaders): DesktopStoredState {
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
      const legacyShared = normalizeSharedReference(t.shared);
      tabs.push({
        ...(legacyShared && { shared: legacyShared }),
        tabId: uniqueId(t.tabId),
        source: normalizeTabSource(t.source, shared?.identity),
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
  const state: DesktopStoredState = { version: DESKTOP_STATE_VERSION, windows: windows.length ? windows : freshDesktopState().windows, recents };
  const rawScripts = (raw as DesktopStateRaw | null)?.sharedScripts;
  if (shared && Array.isArray(rawScripts)) {
    state.sharedScripts = rawScripts.flatMap((rawEntry: unknown) => {
      const entry = shared.entry(rawEntry);
      return entry ? [{ ...entry, ...((rawEntry as DesktopStateRaw).recent === false && { recent: false as const }) }] : [];
    });
  }
  const rawCopies = (raw as DesktopStateRaw | null)?.sharedFileCopies;
  if (shared && Array.isArray(rawCopies)) {
    const paths = new Set<string>(), scripts = new Set<string>();
    state.sharedFileCopies = rawCopies.flatMap((value: unknown) => {
      const identity = shared.identity(value);
      if (!identity) return [];
      const { absPath, docId, fingerprint, missing } = value as Partial<SharedFileRecord>;
      if (typeof absPath !== "string" || !path.isAbsolute(absPath) || !/\.(splitpage|md)$/i.test(absPath) || typeof docId !== "string" ||
          !/^d[a-f0-9]{32}$/.test(docId) || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint) ||
          typeof missing !== "number" || !Number.isSafeInteger(missing) || missing < 0) return [];
      const key = pathKey(absPath), script = identity.deployment + "/" + identity.script;
      if (paths.has(key) || scripts.has(script)) return [];
      paths.add(key);
      scripts.add(script);
      return [{ ...identity, absPath, docId, fingerprint, missing }];
    });
  }
  const lastSavedFolder = raw && (raw as DesktopStateRaw).lastSavedFolder;
  if (typeof lastSavedFolder === "string" && path.isAbsolute(lastSavedFolder)) {
    return { ...state, lastSavedFolder };
  }
  return state;
}

function createDesktopStateStore({ filePath, pathKey, onWriteError, shared }: {
  filePath: () => string;
  pathKey: (path: string) => string;
  onWriteError?: (error: unknown) => void;
  shared?: DesktopSharedStateReaders;
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
    const state = isObject && (parsed as DesktopStateRaw).version === DESKTOP_STATE_VERSION ? normalizeDesktopStateV2(parsed, pathKey, shared)
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
            const next = normalizeDesktopStateV2(result && typeof result === "object" ? result : current, pathKey, shared);
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
interface DesktopSharedStateReaders {
  readonly identity: typeof readSharedScriptIdentity;
  readonly entry: typeof readSharedScriptCatalogueEntry;
}
export interface DesktopStoredTab {
  shared?: DesktopSharedScriptReference;
  tabId: string;
  source: { kind: "blank" } | { kind: "file"; absPath: string } | ({ kind: "shared" } & SharedScriptIdentity);
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
  sharedFileCopies?: SharedFileRecord[];
  version: number;
  lastSavedFolder?: string;
  windows: DesktopStoredWindow[];
  recents: { absPath: string; title: string; at: number }[];
  sharedScripts?: (SharedScriptCatalogueEntry & { recent?: false })[];
}
type DesktopStateMutator = (state: DesktopStoredState) => unknown;
export type {
  DESKTOP_STATE_VERSION, TAB_OR_WINDOW_ID_RE, LAST_KNOWN_TITLE_MAX, RECENTS_MAX,
  mintTabOrWindowId, normalizeBounds, normalizeTabSource, normalizeSharedReference, blankDesktopWindow,
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
  normalizeSharedReference,
  blankDesktopWindow,
  freshDesktopState,
  migrateDesktopStateV1,
  normalizeRecentsList,
  normalizeDesktopStateV2,
  createDesktopStateStore
};
