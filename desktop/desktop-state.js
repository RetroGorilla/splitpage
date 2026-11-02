"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { writeFileDurableSync } = require("./drafts.ts");

const DESKTOP_STATE_VERSION = 2;
const TAB_OR_WINDOW_ID_RE = /^[0-9a-f]{32}$/;
const LAST_KNOWN_TITLE_MAX = 300;
const RECENTS_MAX = 20;
const DESKTOP_STATE_TMP_RE = /^\.tmp-[0-9a-f]{12}-desktop-state\.json$/;

function mintTabOrWindowId() { return crypto.randomBytes(16).toString("hex"); }

function normalizeBounds(b) {
  if (!b || typeof b !== "object") return null;
  const ok = ["x", "y", "width", "height"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k]));
  return ok ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
}

function normalizeTabSource(src) {
  if (src && typeof src === "object") {
    if (src.kind === "file" && typeof src.absPath === "string" && src.absPath && path.isAbsolute(src.absPath)) {
      return { kind: "file", absPath: src.absPath };
    }
  }
  return { kind: "blank" };
}

function blankDesktopWindow(extra) {
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

function freshDesktopState() {
  return { version: DESKTOP_STATE_VERSION, windows: [blankDesktopWindow()], recents: [] };
}

function migrateDesktopStateV1(v1) {
  const tabId = mintTabOrWindowId();
  const source = typeof v1.lastFilePath === "string" && v1.lastFilePath
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

function normalizeRecentsList(raw, pathKey) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
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

function normalizeDesktopStateV2(raw, pathKey) {
  const seen = new Set();
  const uniqueId = (id) => {
    const v = typeof id === "string" && TAB_OR_WINDOW_ID_RE.test(id) && !seen.has(id) ? id : mintTabOrWindowId();
    seen.add(v);
    return v;
  };
  const windows = [];
  for (const w of Array.isArray(raw && raw.windows) ? raw.windows : []) {
    if (!w || typeof w !== "object") continue;
    const tabs = [];
    for (const t of Array.isArray(w.tabs) ? w.tabs : []) {
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
      activeTabId: tabs.some((t) => t.tabId === w.activeTabId) ? w.activeTabId : tabs[0].tabId,
      tabs
    });
  }
  const recents = normalizeRecentsList(raw && raw.recents, pathKey);
  if (!windows.length) {
    const fresh = freshDesktopState();
    fresh.recents = recents;
    return fresh;
  }
  return { version: DESKTOP_STATE_VERSION, windows, recents };
}

function createDesktopStateStore({ filePath, pathKey, onWriteError }) {
  let synthesized = null;
  const queue = [];
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
    let parsed;
    try { parsed = text === null ? undefined : JSON.parse(text); } catch { parsed = undefined; }

    const isObject = !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    const state = isObject && parsed.version === DESKTOP_STATE_VERSION ? normalizeDesktopStateV2(parsed, pathKey)
      : isObject && !("version" in parsed) ? migrateDesktopStateV1(parsed)
      : freshDesktopState();
    synthesized = { text, state: structuredClone(state) };
    return state;
  }

  function write(mutator) {
    return new Promise((resolve) => {
      queue.push({ mutator, resolve });
      if (!draining) drain();
    });
  }

  function drain() {
    draining = true;
    try {
      while (queue.length) {
        const job = queue.shift();
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
