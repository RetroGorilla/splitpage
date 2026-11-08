"use strict";

import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import type * as NodePath from "node:path";
import type * as NodeZlib from "node:zlib";
import type * as VideoEmbed from "../shared/video-embed.ts";
import type { BundleProgress } from "./bundle-copy.ts";

const fs: typeof NodeFs = require("node:fs");
const fsp: typeof NodeFsPromises = require("node:fs/promises");
const path: typeof NodePath = require("node:path");
const zlib: typeof NodeZlib = require("node:zlib");

interface BundleExportSource {
  readonly name: string;
  readonly from: string;
  readonly size: number;
  readonly mtime: Date;
}

interface BundleExportLayout {
  readonly script: string;
  readonly folder: string;
  readonly body: Buffer;
  readonly sources: readonly BundleExportSource[];
  readonly left: number;
  readonly edited: Date;
}

type BundleExportResult = { ok: true; files: number; left: number } | { ok: false; code: "CANCELLED" | "FAILED" | "TAKEN" };

interface ZipRecord {
  readonly name: Buffer;
  readonly method: number;
  readonly crc: number;
  readonly size: number;
  readonly packed: number;
  readonly offset: number;
  readonly folder: boolean;
}

const MAX16 = 0xFFFF;
const MAX32 = 0xFFFFFFFF;
const UTF8_NAMES = 0x0800;
const SCRIPT_NAME = /\.splitpage$/i;
const NUMBERED_TRIES = 999;
const READ_CHUNK = 1024 * 1024;

let crcTable: Uint32Array | null = null;

function crcOf(bytes: Uint8Array, crc: number): number {
  const native = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;
  if (typeof native === "function") return native(bytes, crc);
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ MAX32) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = ((crcTable[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  return (c ^ MAX32) >>> 0;
}

const DOS_EPOCH = new Date(1980, 0, 1);

function dosStamp(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((Math.max(0, at.getFullYear() - 1980) & 0x7f) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  };
}

function stampable(at: unknown): Date {
  const d = typeof at === "string" || at instanceof Date ? new Date(at) : null;
  return d && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1980 && d.getFullYear() < 2108 ? d : DOS_EPOCH;
}

async function writeAll(handle: NodeFsPromises.FileHandle, bytes: Uint8Array, at: number): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, at + done);
    if (!(bytesWritten > 0)) throw new Error("the export file took no bytes");
    done += bytesWritten;
  }
}

function createBundleExporter(options: {
  bundleFiles: Pick<typeof VideoEmbed, "bundleableName" | "fileLinksIn" | "numberedName" | "projectRecord">;
  publisher: { readonly folderName: (script: string) => string; readonly partIn: (folder: string) => string;
    readonly publishWhole: (part: string, target: string, signal: AbortSignal, replace: boolean) => Promise<"copied" | "taken" | "cancelled" | "failed">;
    readonly resolveIn: (script: string, name: unknown, allow: RegExp) => Promise<VideoEmbed.VideoPathVerdict> };
  foldCase?: boolean;
  zip64Above?: number;
  openPart?: (part: string) => Promise<NodeFsPromises.FileHandle>;
  readFile?: (from: string) => NodeJS.ReadableStream;
}) {
  const { bundleableName, fileLinksIn, numberedName, projectRecord } = options.bundleFiles;
  const { folderName, partIn, publishWhole, resolveIn } = options.publisher;
  const foldCase = typeof options.foldCase === "boolean" ? options.foldCase : process.platform === "win32";
  const wide = typeof options.zip64Above === "number" ? options.zip64Above : MAX32;
  const openPart = options.openPart || ((part: string) => fsp.open(part, "wx"));
  const readFile = options.readFile || ((from: string) => fs.createReadStream(from, { highWaterMark: READ_CHUNK }));
  const key = (s: string) => (foldCase ? s.toLowerCase() : s);

  function scriptNameOk(name: unknown): name is string {
    return bundleableName(name, SCRIPT_NAME);
  }

  async function regularFile(p: string): Promise<{ size: number; mtime: Date } | null> {
    try {
      const st = await fsp.stat(p);
      return st.isFile() ? { size: st.size, mtime: stampable(st.mtime) } : null;
    } catch { return null; }
  }

  async function layout(text: string, scriptName: string, scriptPath: string | null, allow: RegExp): Promise<BundleExportLayout | null> {
    if (!scriptNameOk(scriptName)) return null;
    const record = projectRecord(text);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const lost = new Set<string>();
    const taken = new Set<string>();
    const kept: { holder: VideoEmbed.FileLinkHolder; name: string; from: string; size: number; mtime: Date }[] = [];
    for (const holder of fileLinksIn(record)) {
      const at = holder.location;
      // why: a script is untrusted, so its path links never authorize a read; they stay paths and are counted
      if (at.kind !== "bundled") { lost.add("p:" + key(at.path)); continue; }
      const found = scriptPath ? await resolveIn(scriptPath, at.name, allow) : null;
      const file = found && found.ok ? await regularFile(found.path) : null;
      // why: an empty file may be a placeholder a crashed copy left, so it is never exported as the linked file
      if (!found || !found.ok || !file || !file.size) { lost.add("b:" + key(at.name)); taken.add(at.name.toLowerCase()); continue; }
      kept.push({ holder, name: at.name, from: found.path, ...file });
    }
    const named = new Map<string, string>();
    const sources: BundleExportSource[] = [];
    for (const k of kept) {
      let name = named.get(key(k.from));
      if (!name) {
        for (let n = 1; n <= NUMBERED_TRIES && !name; n++) {
          const candidate = numberedName(k.name, n);
          if (!bundleableName(candidate, allow)) break;
          if (!taken.has(candidate.toLowerCase())) name = candidate;
        }
        if (!name) { lost.add("b:" + key(k.name)); continue; }
        taken.add(name.toLowerCase());
        named.set(key(k.from), name);
        sources.push({ name, from: k.from, size: k.size, mtime: k.mtime });
      }
      k.holder.location = { kind: "bundled", name };
    }
    return {
      script: scriptName, folder: folderName(scriptName), body: Buffer.from(JSON.stringify(record, null, 2), "utf8"),
      sources, left: lost.size, edited: stampable((record as { lastEditedAt?: unknown }).lastEditedAt)
    };
  }

  function localHeader(r: Omit<ZipRecord, "offset">, stamp: { time: number; date: number }): Buffer {
    const big = r.size >= wide || r.packed >= wide;
    const extra = Buffer.alloc(big ? 20 : 0);
    if (big) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(r.size), 4);
      extra.writeBigUInt64LE(BigInt(r.packed), 12);
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(big ? 45 : 20, 4);
    h.writeUInt16LE(UTF8_NAMES, 6);
    h.writeUInt16LE(r.method, 8);
    h.writeUInt16LE(stamp.time, 10);
    h.writeUInt16LE(stamp.date, 12);
    h.writeUInt32LE(r.crc >>> 0, 14);
    h.writeUInt32LE(big ? MAX32 : r.packed, 18);
    h.writeUInt32LE(big ? MAX32 : r.size, 22);
    h.writeUInt16LE(r.name.length, 26);
    h.writeUInt16LE(extra.length, 28);
    return Buffer.concat([h, r.name, extra]);
  }

  function centralHeader(r: ZipRecord, stamp: { time: number; date: number }): Buffer {
    const wides = [r.size >= wide ? r.size : null, r.packed >= wide ? r.packed : null, r.offset >= wide ? r.offset : null]
      .filter((v): v is number => v !== null);
    const extra = Buffer.alloc(wides.length ? 4 + wides.length * 8 : 0);
    if (wides.length) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(wides.length * 8, 2);
      wides.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
    }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(45, 4);
    h.writeUInt16LE(wides.length ? 45 : 20, 6);
    h.writeUInt16LE(UTF8_NAMES, 8);
    h.writeUInt16LE(r.method, 10);
    h.writeUInt16LE(stamp.time, 12);
    h.writeUInt16LE(stamp.date, 14);
    h.writeUInt32LE(r.crc >>> 0, 16);
    h.writeUInt32LE(r.packed >= wide ? MAX32 : r.packed, 20);
    h.writeUInt32LE(r.size >= wide ? MAX32 : r.size, 24);
    h.writeUInt16LE(r.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt32LE(r.folder ? 0x10 : 0, 38);
    h.writeUInt32LE(r.offset >= wide ? MAX32 : r.offset, 42);
    return Buffer.concat([h, r.name, extra]);
  }

  function endRecords(count: number, cdOffset: number, cdSize: number): Buffer {
    const big = count >= MAX16 || cdOffset >= wide || cdSize >= wide;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(big ? MAX16 : count, 8);
    end.writeUInt16LE(big ? MAX16 : count, 10);
    end.writeUInt32LE(big ? MAX32 : cdSize, 12);
    end.writeUInt32LE(big ? MAX32 : cdOffset, 16);
    if (!big) return end;
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    locator.writeUInt32LE(1, 16);
    return Buffer.concat([z, locator, end]);
  }

  async function writeZip(handle: NodeFsPromises.FileHandle, plan: BundleExportLayout, signal: AbortSignal, onProgress: BundleProgress): Promise<"done" | "cancelled" | "failed"> {
    const total = plan.body.length + plan.sources.reduce((sum, s) => sum + s.size, 0);
    const stopped = new Promise<"stopped">((resolve) => {
      if (signal.aborted) resolve("stopped");
      else signal.addEventListener("abort", () => resolve("stopped"), { once: true });
    });
    let done = 0;
    let pos = 0;
    const records: (ZipRecord & { stamp: { time: number; date: number } })[] = [];
    const put = async (bytes: Uint8Array) => { await writeAll(handle, bytes, pos); pos += bytes.length; };
    const edited = dosStamp(plan.edited);
    const whole = async (name: string, data: Buffer, method: number, size: number, crc: number, folder: boolean) => {
      const r = { name: Buffer.from(name, "utf8"), method, crc, size, packed: data.length, folder };
      const offset = pos;
      await put(localHeader(r, edited));
      await put(data);
      records.push({ ...r, offset, stamp: edited });
    };
    const packed = zlib.deflateRawSync(plan.body);
    await whole(plan.script, packed, 8, plan.body.length, crcOf(plan.body, 0), false);
    done += plan.body.length;
    onProgress(done, total);
    if (plan.sources.length) await whole(plan.folder + "/", Buffer.alloc(0), 0, 0, 0, true);
    for (const s of plan.sources) {
      if (signal.aborted) return "cancelled";
      const stamp = dosStamp(s.mtime);
      const r = { name: Buffer.from(plan.folder + "/" + s.name, "utf8"), method: 0, crc: 0, size: s.size, packed: s.size, folder: false };
      const offset = pos;
      await put(localHeader(r, stamp));
      let crc = 0;
      let read = 0;
      const stream = readFile(s.from);
      const chunks = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = chunks.next();
          next.catch(() => {});
          const step = await Promise.race([next, stopped]);
          if (step === "stopped") return "cancelled";
          if (step.done) break;
          const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value);
          read += chunk.length;
          if (read > s.size) return "failed";
          crc = crcOf(chunk, crc);
          await put(chunk);
          done += chunk.length;
          onProgress(done, total);
        }
      } finally { (stream as { destroy?: () => void }).destroy?.(); }
      if (read !== s.size) return "failed";
      const at = Buffer.alloc(4);
      at.writeUInt32LE(crc >>> 0, 0);
      await writeAll(handle, at, offset + 14);
      records.push({ ...r, crc, offset, stamp });
    }
    if (signal.aborted) return "cancelled";
    const cdOffset = pos;
    for (const r of records) await put(centralHeader(r, r.stamp));
    await put(endRecords(records.length, cdOffset, pos - cdOffset));
    return "done";
  }

  async function write(plan: BundleExportLayout, target: string, replace: boolean, signal: AbortSignal, onProgress: BundleProgress): Promise<BundleExportResult> {
    if (signal.aborted) return { ok: false, code: "CANCELLED" };
    const part = partIn(path.dirname(target));
    let handle: NodeFsPromises.FileHandle;
    try { handle = await openPart(part); } catch { return { ok: false, code: "FAILED" }; }
    let wrote: "done" | "cancelled" | "failed";
    let published: "copied" | "taken" | "cancelled" | "failed" = "failed";
    try {
      try { wrote = await writeZip(handle, plan, signal, onProgress); } catch { wrote = signal.aborted ? "cancelled" : "failed"; }
      try { await handle.close(); } catch { wrote = "failed"; }
      if (wrote === "done") published = await publishWhole(part, target, signal, replace);
    } finally {
      if (published !== "copied") { try { await fsp.unlink(part); } catch { } }
    }
    if (published === "copied") return { ok: true, files: plan.sources.length, left: plan.left };
    if (wrote === "cancelled" || published === "cancelled" || signal.aborted) return { ok: false, code: "CANCELLED" };
    return { ok: false, code: published === "taken" ? "TAKEN" : "FAILED" };
  }

  return { layout, scriptNameOk, write };
}

export type { BundleExportLayout, BundleExportResult, createBundleExporter };

module.exports = { createBundleExporter };
