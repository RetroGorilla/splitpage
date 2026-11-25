"use strict";

import type * as NodePath from "node:path";
import type { createFileRegistry, pathKey as filePathKey } from "./file-service.ts";
import type {
  createDesktopStateStore, LAST_KNOWN_TITLE_MAX as DesktopTitleLimit, RECENTS_MAX as DesktopRecentsLimit
} from "./desktop-state.ts";
import type { SharedScriptCatalogueEntry, sharedScriptKey as SharedScriptKey } from "../shared/shared-script.ts";
import type { DesktopWireRecent } from "../shared/desktop-contract.d.ts";

const path: typeof NodePath = require("node:path");
const { LAST_KNOWN_TITLE_MAX, RECENTS_MAX }: {
  LAST_KNOWN_TITLE_MAX: typeof DesktopTitleLimit; RECENTS_MAX: typeof DesktopRecentsLimit
} = require("./desktop-state.ts");

type DesktopRecentsStateStore = Pick<ReturnType<typeof createDesktopStateStore>, "read" | "write">;
type DesktopRecentRecord = ReturnType<DesktopRecentsStateStore["read"]>["recents"][number];

function createRecents({ store, pathKey, fileIds, shared }: {
  store: DesktopRecentsStateStore;
  pathKey: typeof filePathKey;
  fileIds: ReturnType<typeof createFileRegistry>;
  shared?: false | typeof SharedScriptKey;
}) {
  let recentDocuments: DesktopRecentRecord[] = [];
  const recentFileIdByPath = new Map<string, string>();

  function fileIdForPath(absPath: string) {
    const key = pathKey(absPath);
    const existing = recentFileIdByPath.get(key);
    if (existing && fileIds.pathOf(existing) === absPath) return existing;
    const id = fileIds.register(absPath);
    recentFileIdByPath.set(key, id);
    return id;
  }

  function load() {
    recentDocuments = store.read().recents || [];
  }

  function persist() {
    const snapshot = recentDocuments.map((r) => ({ ...r }));
    return store.write((current) => { current.recents = snapshot; return current; });
  }

  function note(absPath: unknown, title: unknown) {
    if (typeof absPath !== "string" || !absPath) return false;
    const key = pathKey(absPath);
    const name = typeof title === "string" ? title.slice(0, LAST_KNOWN_TITLE_MAX) : "";
    const at = Date.now();
    const existingIndex = recentDocuments.findIndex((r) => pathKey(r.absPath) === key);
    if (existingIndex === 0) {
      const head = recentDocuments[0] as DesktopRecentRecord;
      head.at = at;
      if (!name || head.title === name) return false;
      head.title = name;
      return true;
    }
    const previous = existingIndex === -1 ? null : recentDocuments.splice(existingIndex, 1)[0];
    recentDocuments.unshift({
      absPath,
      title: name || (previous ? previous.title : ""),
      at
    });
    if (recentDocuments.length > RECENTS_MAX) recentDocuments.length = RECENTS_MAX;
    return true;
  }

  function removeByFileId(fileId: unknown) {
    const absPath = typeof fileId === "string" ? fileIds.pathOf(fileId) : null;
    if (!absPath) return false;
    const key = pathKey(absPath);
    const before = recentDocuments.length;
    recentDocuments = recentDocuments.filter((r) => pathKey(r.absPath) !== key);
    return recentDocuments.length !== before;
  }

  function clear() {
    if (!recentDocuments.length) return false;
    recentDocuments = [];
    return true;
  }

  function sharedRecentId(key: typeof SharedScriptKey, entry: SharedScriptCatalogueEntry) {
    return `shared:${key(entry)}`;
  }

  function findSharedRecent(id: string) {
    return shared ? store.read().sharedScripts?.find(entry => entry.recent !== false && sharedRecentId(shared, entry) === id) : undefined;
  }

  function hideSharedRecents(id?: string) {
    if (!shared) return;
    return store.write(current => {
      const entries = current.sharedScripts?.filter(entry => entry.recent !== false && (!id || sharedRecentId(shared, entry) === id));
      if (!entries?.length) return false;
      for (const entry of entries) entry.recent = false;
      return current;
    });
  }

  function forRenderer(): DesktopWireRecent[] {
    const files = recentDocuments.map((r) => ({
      fileId: fileIdForPath(r.absPath),
      name: path.basename(r.absPath),
      title: r.title || "",
      at: r.at || 0
    }));
    if (!shared) return files;
    const scripts = (store.read().sharedScripts ?? []).filter(entry => entry.recent !== false).map(entry => ({
      shared: true as const,
      fileId: sharedRecentId(shared, entry),
      name: entry.title || "Untitled Script",
      title: entry.title,
      at: entry.at
    }));
    return [...files, ...scripts].sort((a, b) => b.at - a.at).slice(0, RECENTS_MAX);
  }

  function list() { return recentDocuments; }

  function lastSavedFolder() { return store.read().lastSavedFolder; }

  function noteSaved(absPath: unknown) {
    if (typeof absPath !== "string" || !path.isAbsolute(absPath)) return Promise.resolve(false);
    return store.write((current) => { current.lastSavedFolder = path.dirname(absPath); return current; });
  }

  return { load, persist, note, removeByFileId, clear, forRenderer, list, lastSavedFolder, noteSaved, findSharedRecent, hideSharedRecents };
}

export type { createRecents };

module.exports = { createRecents };
