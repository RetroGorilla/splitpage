"use strict";

import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import type * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import type * as NodeStreamPromises from "node:stream/promises";
import type * as VideoEmbed from "../shared/video-embed.ts";

const fs: typeof NodeFs = require("node:fs");
const fsp: typeof NodeFsPromises = require("node:fs/promises");
const path: typeof NodePath = require("node:path");
const { Transform }: typeof NodeStream = require("node:stream");
const { pipeline }: typeof NodeStreamPromises = require("node:stream/promises");

type BundleProgress = (done: number, total: number) => void;
type BundleCopyResult = { ok: true; name: string } | { ok: false; code: "REFUSED" | "GONE" | "CANCELLED" | "FAILED" };
type BundleCarryResult = { ok: true; copied: number; kept: number; failed: number } | { ok: false; code: "CANCELLED"; copied: number };

const NUMBERED_TRIES = 999;

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

  async function writeCopy(source: string, target: string, signal: AbortSignal, counted: (bytes: number) => void): Promise<"copied" | "taken" | "cancelled" | "failed"> {
    if (signal.aborted) return "cancelled";
    let handle: NodeFsPromises.FileHandle;
    try { handle = await fsp.open(target, "wx"); } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EEXIST" ? "taken" : "failed";
    }
    try {
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) { counted(chunk.length); done(null, chunk); }
      });
      await pipeline(fs.createReadStream(source), counter, handle.createWriteStream(), { signal });
      return "copied";
    } catch {
      try { await handle.close(); } catch { }
      try { await fsp.unlink(target); } catch { }
      return signal.aborted ? "cancelled" : "failed";
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

  async function copyIn(source: string, scriptPath: string, allow: RegExp, onProgress: BundleProgress, signal: AbortSignal): Promise<BundleCopyResult> {
    const base = path.basename(source);
    if (!bundleableName(base, allow)) return { ok: false, code: "REFUSED" };
    let total: number;
    try {
      const st = await fsp.stat(source);
      if (!st.isFile()) return { ok: false, code: "REFUSED" };
      total = st.size;
    } catch (e) { return { ok: false, code: missingFile(e) ? "GONE" : "REFUSED" }; }
    try { await fsp.mkdir(bundleFolderOf(scriptPath, path), { recursive: true }); } catch { return { ok: false, code: "FAILED" }; }
    const folder = await realBundleFolder(scriptPath, fsp, path);
    if (!folder.ok) return { ok: false, code: "REFUSED" };
    try {
      if (samePath(await fsp.realpath(path.dirname(source)), folder.path, foldCase)) return { ok: true, name: base };
    } catch { return { ok: false, code: "FAILED" }; }
    const progress = reporter(total, onProgress);
    for (let n = 1; n <= NUMBERED_TRIES; n++) {
      const name = numberedName(base, n);
      if (!bundleableName(name, allow)) return { ok: false, code: "REFUSED" };
      const target = path.join(folder.path, name);
      const size = await sizeOfFile(target);
      if (size === total) return { ok: true, name };
      if (size !== null) continue;
      const got = await writeCopy(source, target, signal, progress.add);
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
    const progress = reporter(sources.reduce((sum, s) => sum + s.size, 0), onProgress);
    let copied = 0, kept = 0;
    for (const s of sources) {
      const target = path.join(folder.path, s.name);
      const size = await sizeOfFile(target);
      if (size === s.size) { kept++; progress.add(s.size); continue; }
      if (size !== null) { failed++; continue; }
      const got = await writeCopy(s.from, target, signal, progress.add);
      if (got === "cancelled") return { ok: false, code: "CANCELLED", copied };
      if (got === "copied") copied++; else failed++;
    }
    progress.finish();
    return { ok: true, copied, kept, failed };
  }

  return { copyIn, carry };
}

export type { BundleCarryResult, BundleCopyResult, BundleProgress, createBundleCopier };

module.exports = { createBundleCopier };
