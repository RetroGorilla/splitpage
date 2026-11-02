"use strict";

import type * as NodePath from "node:path";
import type { createFileRegistry, pathKey as filePathKey } from "./file-service.ts";
import type { DesktopStateStoreBoundary } from "./ipc-boundaries.d.ts";

const path: typeof NodePath = require("node:path");
const { LAST_KNOWN_TITLE_MAX, RECENTS_MAX }: { LAST_KNOWN_TITLE_MAX: number; RECENTS_MAX: number } = require("./desktop-state");

type DesktopRecentRecord = ReturnType<DesktopStateStoreBoundary["read"]>["recents"][number];

function createRecents({ store, pathKey, fileIds }: {
  store: Pick<DesktopStateStoreBoundary, "read" | "write">;
  pathKey: typeof filePathKey;
  fileIds: ReturnType<typeof createFileRegistry>;
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

  function forRenderer() {
    return recentDocuments.map((r) => ({
      fileId: fileIdForPath(r.absPath),
      name: path.basename(r.absPath),
      title: r.title || "",
      at: r.at || 0
    }));
  }

  function list() { return recentDocuments; }

  return { load, persist, note, removeByFileId, clear, forRenderer, list };
}

export type { createRecents };

module.exports = { createRecents };
