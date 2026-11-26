"use strict";

import type * as NodeFsPromises from "node:fs/promises";
import type * as NodePath from "node:path";
import type { createDesktopStateStore } from "./desktop-state.ts";
import type { DesktopFileService } from "./file-service.ts";
import type { SharedFileInfo, SharedFileRecord, SharedFileResult } from "../shared/shared-file-copy.d.ts";

const fsp: typeof NodeFsPromises = require("node:fs/promises");
const path: typeof NodePath = require("node:path");
const { pathKey, fileFingerprint, writeFileEntry }: DesktopFileService = require("./file-service.ts");

type Store = Pick<ReturnType<typeof createDesktopStateStore>, "read" | "write">;
type Registry = ReturnType<DesktopFileService["createFileRegistry"]>;

function fileInfo(record: SharedFileRecord): SharedFileInfo {
  return { name: path.basename(record.absPath), docId: record.docId, missing: record.missing };
}

function scriptKey(record: SharedFileRecord): string {
  return record.deployment + "/" + record.script;
}

function createSharedFileCopies(store: Store, files: Registry, occupied: (key: string) => boolean) {
  const busyPaths = new Set<string>();
  const busyScripts = new Map<string, Promise<void>>();
  const conflicts = new Map<string, string | null>();
  const handles = new Map<string, { absPath: string; id: string }>();
  const orphans = new Set<string>();
  const changed = { kind: "file-copy-problem", problem: "changed" } as const;
  const unavailable = { kind: "file-copy-problem", problem: "unavailable" } as const;
  const none = { kind: "file-copy", file: null } as const;
  const lookup = (name: string) => orphans.has(name) ? undefined
    : store.read().sharedFileCopies?.find(record => scriptKey(record) === name);
  const forPath = (absPath: string) => store.read().sharedFileCopies?.find(record =>
    !orphans.has(scriptKey(record)) && pathKey(record.absPath) === pathKey(absPath));
  const reserved = (absPath: string) => busyPaths.has(pathKey(absPath)) || !!forPath(absPath);

  async function fingerprint(absPath: string): Promise<string | null> {
    try { return fileFingerprint(await fsp.readFile(absPath)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function matches(record: SharedFileRecord): Promise<boolean> {
    try {
      await busyScripts.get(scriptKey(record));
      const latest = forPath(record.absPath);
      return !!latest && await fingerprint(record.absPath) === latest.fingerprint;
    }
    catch { return false; }
  }

  async function status(name: string): Promise<SharedFileResult> {
    const record = lookup(name);
    return record ? { kind: "file-copy", file: fileInfo(record) } : none;
  }

  async function forget(name: string, canRemove?: () => boolean, orphan = false): Promise<boolean> {
    if (busyScripts.has(name) || canRemove?.() === false) return false;
    if (!store.read().sharedFileCopies?.some(record => scriptKey(record) === name)) return true;
    const result = await store.write(state => {
      if (canRemove?.() === false) return false;
      state.sharedFileCopies = state.sharedFileCopies?.filter(record => scriptKey(record) !== name) ?? [];
    });
    if (result) {
      conflicts.delete(name);
      handles.delete(name);
      orphans.delete(name);
    } else if (orphan && canRemove?.() !== false) orphans.add(name);
    return result;
  }

  async function releaseOrphan(name: string, canRemove?: () => boolean): Promise<boolean> {
    let write = busyScripts.get(name);
    while (write && canRemove?.() !== false) {
      await write;
      write = busyScripts.get(name);
    }
    return forget(name, canRemove, true);
  }

  async function write(name: string, data: Uint8Array, missing: number, mode: "check" | "overwrite" | "new" | "export", docId: string,
    pick: () => Promise<string | null>): Promise<SharedFileResult> {
    const record = lookup(name);
    if (!record) return none;
    const newFile = mode === "new" || mode === "export";
    if (busyScripts.has(name) || (newFile ? docId === record.docId : docId !== record.docId)) return unavailable;
    let finish = () => {};
    busyScripts.set(name, new Promise<void>(resolve => { finish = resolve; }));
    let writingKey: string | undefined;
    try {
      const absPath = newFile ? await pick() : record.absPath;
      if (!absPath || !path.isAbsolute(absPath)) return unavailable;
      const key = pathKey(absPath);
      if (newFile && (reserved(absPath) || occupied(key))) return unavailable;
      writingKey = key;
      busyPaths.add(key);
      const observed = await fingerprint(absPath);
      const allowed = newFile || observed === record.fingerprint ||
        (mode === "overwrite" && conflicts.has(name) && observed === conflicts.get(name));
      if (!allowed) {
        conflicts.set(name, observed);
        return changed;
      }
      const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      const digest = fileFingerprint(buffer);
      let lastModified: number | undefined;
      if (observed !== digest) {
        const result = await writeFileEntry(absPath, buffer, undefined, async () => {
          const before = await fingerprint(absPath);
          if (before !== observed) {
            if (!newFile) conflicts.set(name, before);
            throw newFile ? unavailable : changed;
          }
        });
        lastModified = result.lastModified;
      }
      const readback = await fingerprint(absPath);
      if (readback !== digest) {
        if (!newFile) conflicts.set(name, readback);
        return newFile ? unavailable : changed;
      }
      lastModified ??= Math.floor((await fsp.stat(absPath)).mtimeMs);
      const updated = { ...record, absPath, docId, fingerprint: digest, missing };
      if (mode !== "export" && (record.fingerprint !== digest || record.missing !== missing || record.absPath !== absPath)) {
        const persisted = await store.write(state => {
          state.sharedFileCopies = state.sharedFileCopies?.map(copy => scriptKey(copy) === name ? updated : copy) ?? [];
        });
        if (!persisted) return unavailable;
      }
      if (mode !== "export") conflicts.delete(name);
      const existing = handles.get(name);
      const id = existing?.absPath === absPath ? existing.id : files.register(absPath);
      if (mode !== "export") handles.set(name, { absPath, id });
      files.rememberBytes(id, buffer);
      return { kind: "file-copy-written", file: fileInfo(updated), id, lastModified };
    } catch (error) { return error === changed ? changed : unavailable; }
    finally {
      if (writingKey) busyPaths.delete(writingKey);
      busyScripts.delete(name);
      finish();
    }
  }

  return { lookup, forPath, reserved, matches, status, forget, releaseOrphan, write };
}

export type { createSharedFileCopies };
module.exports = { createSharedFileCopies };
