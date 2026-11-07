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
type BundleCarryResult = { ok: true; copied: number; kept: number; failed: number } | { ok: false; code: "CANCELLED"; copied: number };

const NUMBERED_TRIES = 999;
const PART_NAME = /^~splitpage-[0-9a-f]{16}\.part$/;
const COMPARE_CHUNK = 1024 * 1024;

function createBundleCopier(options: {
  bundleFiles: Pick<typeof VideoEmbed, "bundleFolderOf" | "bundleableName" | "missingFile" | "numberedName" | "realBundleFolder" | "resolveBundledFile" | "samePath">;
  foldCase?: boolean;
  progressEveryMs?: number;
}) {
  const {
    bundleFolderOf, bundleableName, missingFile, numberedName, realBundleFolder, resolveBundledFile, samePath
  } = options.bundleFiles;
  const foldCase = typeof options.foldCase === "boolean" ? options.foldCase : process.platform === "win32";
  const every = typeof options.progressEveryMs === "number" ? options.progressEveryMs : 100;

  const writing = new Set<string>();

  async function sweep(folder: string): Promise<void> {
    let entries: string[];
    try { entries = await fsp.readdir(folder); } catch { return; }
    for (const name of entries) {
      const at = path.join(folder, name);
      if (PART_NAME.test(name) && !writing.has(at)) { try { await fsp.unlink(at); } catch { } }
    }
  }

  async function publish(part: string, target: string): Promise<"copied" | "taken" | "failed"> {
    let linked = false;
    try { await fsp.link(part, target); linked = true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return "taken";
    }
    if (linked) {
      try { await fsp.unlink(part); } catch { }
      return "copied";
    }
    try { await (await fsp.open(target, "wx")).close(); } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EEXIST" ? "taken" : "failed";
    }
    try { await fsp.rename(part, target); return "copied"; } catch {
      try { await fsp.unlink(target); } catch { }
      return "failed";
    }
  }

  async function writeCopy(source: string, target: string, signal: AbortSignal, counted: (bytes: number) => void): Promise<"copied" | "taken" | "cancelled" | "failed"> {
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
      const published = signal.aborted ? "cancelled" : await publish(part, target);
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
    await sweep(folder.path);
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

  async function carry(fromScript: string | null, toScript: string, names: readonly unknown[], allow: RegExp, onProgress: BundleProgress, signal: AbortSignal): Promise<BundleCarryResult> {
    const wanted = [...new Set(names)];
    if (!fromScript || !wanted.length || samePath(bundleFolderOf(fromScript, path), bundleFolderOf(toScript, path), foldCase)) {
      return { ok: true, copied: 0, kept: 0, failed: 0 };
    }
    let failed = 0;
    const sources: { name: string; from: string; size: number }[] = [];
    for (const name of wanted) {
      const found = await resolveBundledFile(fromScript, name, allow, fsp, path, foldCase);
      const size = found.ok ? await sizeOfFile(found.path) : null;
      if (!found.ok || size === null || size < 0) { failed++; continue; }
      sources.push({ name: name as string, from: found.path, size });
    }
    if (!sources.length) return { ok: true, copied: 0, kept: 0, failed };
    try { await fsp.mkdir(bundleFolderOf(toScript, path), { recursive: true }); } catch { return { ok: true, copied: 0, kept: 0, failed: failed + sources.length }; }
    const folder = await realBundleFolder(toScript, fsp, path);
    if (!folder.ok) return { ok: true, copied: 0, kept: 0, failed: failed + sources.length };
    await sweep(folder.path);
    const progress = reporter(sources.reduce((sum, s) => sum + s.size, 0), onProgress);
    let copied = 0, kept = 0;
    for (const s of sources) {
      const target = path.join(folder.path, s.name);
      const size = await sizeOfFile(target);
      if (size === s.size) {
        const same = await sameBytes(s.from, target, signal);
        if (same === "cancelled") return { ok: false, code: "CANCELLED", copied };
        if (same) { kept++; progress.add(s.size); continue; }
      }
      if (size !== null) { failed++; continue; }
      const got = await writeCopy(s.from, target, signal, progress.add);
      if (got === "cancelled") return { ok: false, code: "CANCELLED", copied };
      if (got === "copied") copied++; else failed++;
    }
    progress.finish();
    return { ok: true, copied, kept, failed };
  }

  async function copyOn(fromScript: string, name: string, toScript: string, allow: RegExp, onProgress: BundleProgress, signal: AbortSignal): Promise<BundleCopyResult> {
    const found = await resolveBundledFile(fromScript, name, allow, fsp, path, foldCase);
    if (!found.ok) return found;
    return copyIn(found.path, toScript, allow, onProgress, signal);
  }

  async function clashIn(fromScript: string, toScript: string, names: readonly string[], allow: RegExp): Promise<string | null> {
    if (samePath(bundleFolderOf(fromScript, path), bundleFolderOf(toScript, path), foldCase)) return null;
    const folder = await realBundleFolder(toScript, fsp, path);
    if (!folder.ok) return null;
    for (const name of names) {
      const found = await resolveBundledFile(fromScript, name, allow, fsp, path, foldCase);
      if (!found.ok) continue;
      const target = path.join(folder.path, name);
      const size = await sizeOfFile(target);
      if (size === null) continue;
      const fromSize = await sizeOfFile(found.path);
      if (size !== fromSize || (await sameBytes(found.path, target, new AbortController().signal)) !== true) return name;
    }
    return null;
  }

  function folderName(script: string): string {
    return path.basename(bundleFolderOf(script, path));
  }

  return { clashIn, copyIn, copyOn, carry, folderName };
}

export type { BundleCarryResult, BundleCopyResult, BundleProgress, createBundleCopier };

module.exports = { createBundleCopier };
