"use strict";

import type * as NodeCrypto from "node:crypto";
import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import type * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import type * as NodeStreamPromises from "node:stream/promises";
import type * as VideoEmbed from "../shared/video-embed.ts";

const crypto: typeof NodeCrypto = require("node:crypto");
const fs: typeof NodeFs = require("node:fs");
const fsp: typeof NodeFsPromises = require("node:fs/promises");
const path: typeof NodePath = require("node:path");
const { Transform }: typeof NodeStream = require("node:stream");
const { pipeline }: typeof NodeStreamPromises = require("node:stream/promises");

type BundleProgress = (done: number, total: number) => void;
type BundleCopyResult = { ok: true; name: string } | { ok: false; code: "REFUSED" | "GONE" | "CANCELLED" | "FAILED" };
type BundleCarryResult = { ok: true; copied: number; kept: number; missing: number } |
  { ok: false; code: "CLASH" | "FAILED" | "CANCELLED"; name: string; copied: number } |
  { ok: false; code: "MISSING"; name: string; copied: 0; missing: number };
interface BundleCarryHooks {
  readonly source?: (name: string) => Promise<VideoEmbed.VideoPathVerdict>;
  readonly strict?: boolean;
  readonly ready?: (pending: readonly string[]) => Promise<boolean>;
}

const NUMBERED_TRIES = 999;
const PART_NAME = /^~splitpage-[0-9a-f]{16}\.part$/;
const COMPARE_CHUNK = 1024 * 1024;

function createBundleCopier(options: {
  bundleFiles: Pick<typeof VideoEmbed, "bundleFolderOf" | "bundleableName" | "missingFile" | "numberedName" | "openableVideoPath" | "realBundleFolder" |
    "resolveBundledFile" | "samePath">;
  foldCase?: boolean;
  pathStyle?: "win32" | "posix";
  progressEveryMs?: number;
  link?: typeof fsp.link;
  openTarget?: (target: string) => Promise<NodeFsPromises.FileHandle>;
  lstat?: (target: string) => Promise<NodeFs.BigIntStats>;
  rename?: typeof fsp.rename;
  unlink?: typeof fsp.unlink;
}) {
  const {
    bundleFolderOf, bundleableName, missingFile, numberedName, openableVideoPath, realBundleFolder, resolveBundledFile, samePath
  } = options.bundleFiles;
  const pathStyle = options.pathStyle || (process.platform === "win32" ? "win32" : "posix");
  const foldCase = typeof options.foldCase === "boolean" ? options.foldCase : process.platform === "win32";
  const every = typeof options.progressEveryMs === "number" ? options.progressEveryMs : 100;

  const linkFile = options.link || fsp.link;
  const openTarget = options.openTarget || ((target: string) => fsp.open(target, "wx"));
  const lstatTarget = options.lstat || ((target: string) => fsp.lstat(target, { bigint: true }));
  const renameFile = options.rename || fsp.rename;
  const unlinkFile = options.unlink || fsp.unlink;
  const writing = new Set<string>();
  const placeholders = new Set<string>();
  const placeKey = (p: string) => (foldCase ? p.toLowerCase() : p);
  const publishing = new Map<string, Promise<void>>();

  async function underFolderLock<T>(folder: string, signal: AbortSignal, step: () => Promise<T>): Promise<T | "cancelled"> {
    const key = foldCase ? folder.toLowerCase() : folder;
    const before = publishing.get(key) || Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = before.then(() => mine);
    publishing.set(key, tail);
    const settle = () => { release(); if (publishing.get(key) === tail) publishing.delete(key); };
    const turn = await Promise.race([before.then(() => true), new Promise<boolean>((resolve) => {
      if (signal.aborted) resolve(false);
      else signal.addEventListener("abort", () => resolve(false), { once: true });
    })]);
    if (!turn) { void before.then(settle); return "cancelled"; }
    try {
      if (signal.aborted) return "cancelled";
      return await step();
    } finally { settle(); }
  }

  async function sweep(folder: string, since: number): Promise<void> {
    let entries: string[];
    try { entries = await fsp.readdir(folder); } catch { return; }
    for (const name of entries) {
      const at = path.join(folder, name);
      if (!PART_NAME.test(name) || writing.has(at)) continue;
      try { if ((await fsp.lstat(at)).mtimeMs < since) await fsp.unlink(at); } catch { }
    }
  }

  async function stillPlaceholder(target: string, made: NodeFs.BigIntStats): Promise<boolean> {
    try {
      const now = await lstatTarget(target);
      return now.isFile() && now.ino === made.ino && now.dev === made.dev && now.size === 0n;
    } catch { return false; }
  }

  async function renameOntoPlaceholder(part: string, target: string, signal: AbortSignal): Promise<"copied" | "taken" | "cancelled" | "failed"> {
    let out: NodeFsPromises.FileHandle;
    try { out = await openTarget(target); } catch (e) { return (e as NodeJS.ErrnoException).code === "EEXIST" ? "taken" : "failed"; }
    const key = placeKey(target);
    placeholders.add(key);
    try {
      let made: NodeFs.BigIntStats | null = null;
      try { made = await out.stat({ bigint: true }); } catch { } finally { try { await out.close(); } catch { } }
      if (!made) return "failed";
      if (signal.aborted) {
        if (await stillPlaceholder(target, made)) { try { await unlinkFile(target); } catch { } }
        return "cancelled";
      }
      if (!(await stillPlaceholder(target, made))) return "taken";
      try { await renameFile(part, target); } catch {
        if (await stillPlaceholder(target, made)) { try { await unlinkFile(target); } catch { } }
        return "failed";
      }
      return "copied";
    } finally { placeholders.delete(key); }
  }

  async function publish(part: string, target: string, signal: AbortSignal, published: () => void): Promise<"copied" | "taken" | "cancelled" | "failed"> {
    if (signal.aborted) return "cancelled";
    let linked = false;
    try {
      await linkFile(part, target);
      linked = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return "taken";
    }
    if (!linked) {
      if (signal.aborted) return "cancelled";
      // why: exFAT and SMB shares may lack hard links; the whole .part replaces only the empty placeholder this job created
      const renamed = await renameOntoPlaceholder(part, target, signal);
      if (renamed !== "copied") return renamed;
    }
    published();
    if (linked) { try { await unlinkFile(part); } catch { } }
    return "copied";
  }

  async function writeCopy(source: string, target: string, signal: AbortSignal, counted: (bytes: number) => void,
    onPublished: () => void = () => {}): Promise<"copied" | "taken" | "cancelled" | "failed"> {
    if (signal.aborted) return "cancelled";
    try { await fsp.lstat(target); return "taken"; } catch (e) { if (!missingFile(e)) return "failed"; }
    const part = path.join(path.dirname(target), "~splitpage-" + crypto.randomBytes(8).toString("hex") + ".part");
    let handle: NodeFsPromises.FileHandle;
    try { handle = await fsp.open(part, "wx"); } catch { return "failed"; }
    writing.add(part);
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) { counted(chunk.length); done(null, chunk); }
      });
      await pipeline(fs.createReadStream(source), counter, handle.createWriteStream(), { signal });
      const published = signal.aborted ? "cancelled" : await underFolderLock(path.dirname(target), signal, () => publish(part, target, signal, onPublished));
      if (published !== "copied") { try { await fsp.unlink(part); } catch { } }
      return published;
    } catch {
      try { await handle.close(); } catch { }
      try { await fsp.unlink(part); } catch { }
      return signal.aborted ? "cancelled" : "failed";
    } finally {
      writing.delete(part);
    }
  }

  function reporter(total: number, onProgress: BundleProgress) {
    let done = 0;
    let last = -Infinity;
    return {
      add(bytes: number) {
        done += bytes;
        const now = Date.now();
        if (now - last >= every) { last = now; onProgress(done, total); }
      },
      finish() { onProgress(done, total); }
    };
  }

  async function sizeOfFile(p: string): Promise<number | null> {
    try {
      const st = await fsp.lstat(p);
      return st.isFile() ? st.size : -1;
    } catch (e) { return missingFile(e) ? null : -1; }
  }

  async function sameBytes(a: string, b: string, signal: AbortSignal): Promise<boolean | "cancelled"> {
    let fa: NodeFsPromises.FileHandle | null = null, fb: NodeFsPromises.FileHandle | null = null;
    try {
      fa = await fsp.open(a, "r");
      fb = await fsp.open(b, "r");
      const ba = Buffer.alloc(COMPARE_CHUNK), bb = Buffer.alloc(COMPARE_CHUNK);
      for (;;) {
        if (signal.aborted) return "cancelled";
        const [ra, rb] = await Promise.all([fa.read(ba, 0, COMPARE_CHUNK, null), fb.read(bb, 0, COMPARE_CHUNK, null)]);
        if (ra.bytesRead !== rb.bytesRead) return false;
        if (ra.bytesRead === 0) return true;
        if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
      }
    } catch { return false; } finally {
      if (fa) { try { await fa.close(); } catch { } }
      if (fb) { try { await fb.close(); } catch { } }
    }
  }

  async function copyIn(source: string, scriptPath: string, allow: RegExp, onProgress: BundleProgress, signal: AbortSignal): Promise<BundleCopyResult> {
    const since = Date.now();
    const base = path.basename(source);
    if (!bundleableName(base, allow)) return { ok: false, code: "REFUSED" };
    let real: string;
    let total: number;
    try {
      real = await fsp.realpath(source);
      if (!bundleableName(path.basename(real), allow)) return { ok: false, code: "REFUSED" };
      const st = await fsp.stat(real);
      if (!st.isFile()) return { ok: false, code: "REFUSED" };
      total = st.size;
    } catch (e) { return { ok: false, code: missingFile(e) ? "GONE" : "REFUSED" }; }
    try { await fsp.mkdir(bundleFolderOf(scriptPath, path), { recursive: true }); } catch { return { ok: false, code: "FAILED" }; }
    const folder = await realBundleFolder(scriptPath, fsp, path);
    if (!folder.ok) return { ok: false, code: "REFUSED" };
    if (samePath(path.dirname(real), folder.path, foldCase)) return { ok: true, name: path.basename(real) };
    await sweep(folder.path, since);
    const progress = reporter(total, onProgress);
    for (let n = 1; n <= NUMBERED_TRIES; n++) {
      const name = numberedName(base, n);
      if (!bundleableName(name, allow)) return { ok: false, code: "REFUSED" };
      const target = path.join(folder.path, name);
      const size = await sizeOfFile(target);
      if (size === total) {
        const same = await sameBytes(real, target, signal);
        if (same === "cancelled") return { ok: false, code: "CANCELLED" };
        if (same) return { ok: true, name };
      }
      if (size !== null) continue;
      const got = await writeCopy(real, target, signal, progress.add);
      if (got === "taken") continue;
      if (got === "cancelled") return { ok: false, code: "CANCELLED" };
      if (got === "failed") return { ok: false, code: "FAILED" };
      progress.finish();
      return { ok: true, name };
    }
    return { ok: false, code: "FAILED" };
  }

  async function carry(fromScript: string | null, toScript: string, names: readonly unknown[], allow: RegExp, onProgress: BundleProgress, signal: AbortSignal,
    onCommitted: (copied: number) => void = () => {}, hooks: BundleCarryHooks = {}): Promise<BundleCarryResult> {
    const since = Date.now();
    const wanted = [...new Set(names)];
    if (!fromScript || !wanted.length || samePath(bundleFolderOf(fromScript, path), bundleFolderOf(toScript, path), foldCase)) {
      return { ok: true, copied: 0, kept: 0, missing: 0 };
    }
    let missing = 0;
    let firstMissing = "";
    const sources: { name: string; from: string; size: number; there: boolean }[] = [];
    for (const name of wanted) {
      const found = hooks.source && bundleableName(name, allow) ? await hooks.source(name) : await resolveBundledFile(fromScript, name, allow, fsp, path, foldCase);
      const size = found.ok ? await sizeOfFile(found.path) : null;
      if (!found.ok || size === null || size < 0) {
        if (!missing++) firstMissing = typeof name === "string" ? name : "";
        continue;
      }
      sources.push({ name: name as string, from: found.path, size, there: false });
    }
    if (missing && hooks.strict) return { ok: false, code: "MISSING", name: firstMissing, copied: 0, missing };
    if (!sources.length) return { ok: true, copied: 0, kept: 0, missing };
    let folderPath: string | null = null;
    const existing = await realBundleFolder(toScript, fsp, path);
    if (existing.ok) {
      folderPath = existing.path;
      for (const s of sources) {
        const size = await sizeOfFile(path.join(existing.path, s.name));
        if (size === null) continue;
        const same = size === s.size ? await sameBytes(s.from, path.join(existing.path, s.name), signal) : false;
        if (same === "cancelled") return { ok: false, code: "CANCELLED", name: s.name, copied: 0 };
        if (!same) return { ok: false, code: "CLASH", name: s.name, copied: 0 };
        s.there = true;
      }
    } else if (existing.code !== "GONE") {
      return { ok: false, code: "FAILED", name: (sources[0] as { name: string }).name, copied: 0 };
    }
    if (signal.aborted) return { ok: false, code: "CANCELLED", name: "", copied: 0 };
    if (hooks.ready && (!(await hooks.ready(sources.filter((s) => !s.there).map((s) => s.name))) || signal.aborted)) {
      return { ok: false, code: "CANCELLED", name: "", copied: 0 };
    }
    const progress = reporter(sources.reduce((sum, s) => sum + s.size, 0), onProgress);
    let copied = 0, kept = 0;
    for (const s of sources) {
      if (s.there) { kept++; progress.add(s.size); continue; }
      if (!folderPath) {
        try { await fsp.mkdir(bundleFolderOf(toScript, path), { recursive: true }); } catch { return { ok: false, code: "FAILED", name: s.name, copied }; }
        const made = await realBundleFolder(toScript, fsp, path);
        if (!made.ok) return { ok: false, code: "FAILED", name: s.name, copied };
        folderPath = made.path;
      }
      if (!copied) await sweep(folderPath, since);
      const got = await writeCopy(s.from, path.join(folderPath, s.name), signal, progress.add, () => { copied++; onCommitted(copied); });
      if (got === "cancelled") return { ok: false, code: "CANCELLED", name: s.name, copied };
      if (got === "taken") return { ok: false, code: "CLASH", name: s.name, copied };
      if (got === "failed") return { ok: false, code: "FAILED", name: s.name, copied };
    }
    progress.finish();
    return { ok: true, copied, kept, missing };
  }

  async function replaceWith(part: string, target: string, signal: AbortSignal): Promise<"copied" | "taken" | "cancelled" | "failed"> {
    if (signal.aborted) return "cancelled";
    // why: rename(2) replaces a link itself, so only a regular file, or no entry, may stand where the confirmed zip was
    let regular = true;
    try { regular = (await lstatTarget(target)).isFile(); } catch (e) { if (!missingFile(e)) return "failed"; }
    if (signal.aborted) return "cancelled";
    if (!regular) return "taken";
    try { await renameFile(part, target); return "copied"; } catch { return "failed"; }
  }

  async function publishWhole(part: string, target: string, signal: AbortSignal, replace = false): Promise<"copied" | "taken" | "cancelled" | "failed"> {
    if (signal.aborted) return "cancelled";
    return underFolderLock(path.dirname(target), signal, () => (replace ? replaceWith(part, target, signal) : publish(part, target, signal, () => {})));
  }

  function partIn(folder: string): string {
    return path.join(folder, "~splitpage-" + crypto.randomBytes(8).toString("hex") + ".part");
  }

  function folderName(script: string): string {
    return path.basename(bundleFolderOf(script, path));
  }

  async function resolveIn(script: string, name: unknown, allow: RegExp): Promise<VideoEmbed.VideoPathVerdict> {
    const found = await resolveBundledFile(script, name, allow, fsp, path, foldCase);
    return found.ok && placeholders.has(placeKey(found.path)) ? { ok: false, code: "GONE" } : found;
  }

  function storedPath(script: string, name: string): string {
    return path.join(bundleFolderOf(script, path), name);
  }

  function openStored(p: string, allow: RegExp): Promise<VideoEmbed.VideoPathVerdict> {
    return openableVideoPath(p, pathStyle, fsp, allow);
  }

  return { copyIn, carry, folderName, openStored, partIn, publishWhole, resolveIn, sizeOfFile, storedPath };
}

export type { BundleCarryResult, BundleCopyResult, BundleProgress, createBundleCopier };

module.exports = { createBundleCopier };
