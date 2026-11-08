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
}

interface BundleExportLayout {
  readonly script: string;
  readonly folder: string;
  readonly body: Buffer;
  readonly sources: readonly BundleExportSource[];
  readonly left: number;
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

function dosStamp(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((Math.max(0, at.getFullYear() - 1980) & 0x7f) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  };
}

function createBundleExporter(options: {
  bundleFiles: Pick<typeof VideoEmbed, "bundleableName" | "fileLinksIn" | "numberedName" | "openableVideoPath" | "projectRecord" | "resolveBundledFile">;
  publisher: { readonly folderName: (script: string) => string; readonly partIn: (folder: string) => string;
    readonly publishWhole: (part: string, target: string, signal: AbortSignal) => Promise<"copied" | "taken" | "cancelled" | "failed"> };
  foldCase?: boolean;
  pathStyle?: "win32" | "posix";
  zip64Above?: number;
  now?: () => Date;
}) {
  const { bundleableName, fileLinksIn, numberedName, openableVideoPath, projectRecord, resolveBundledFile } = options.bundleFiles;
  const { folderName, partIn, publishWhole } = options.publisher;
  const foldCase = typeof options.foldCase === "boolean" ? options.foldCase : process.platform === "win32";
  const pathStyle = options.pathStyle || (process.platform === "win32" ? "win32" : "posix");
  const wide = typeof options.zip64Above === "number" ? options.zip64Above : MAX32;
  const now = options.now || (() => new Date());
  const key = (s: string) => (foldCase ? s.toLowerCase() : s);

  function scriptNameOk(name: unknown): name is string {
    return bundleableName(name, SCRIPT_NAME);
  }

  async function regularSize(p: string): Promise<number | null> {
    try {
      const st = await fsp.stat(p);
      return st.isFile() ? st.size : null;
    } catch { return null; }
  }

  async function layout(text: string, scriptName: string, scriptPath: string | null, allow: RegExp): Promise<BundleExportLayout | null> {
    if (!scriptNameOk(scriptName)) return null;
    const record = projectRecord(text);
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    const named = new Map<string, string>();
    const taken = new Set<string>();
    const lost = new Set<string>();
    const sources: BundleExportSource[] = [];
    for (const holder of fileLinksIn(record)) {
      const at = holder.location;
      const wanted = at.kind === "bundled" ? "b:" + key(at.name) : "p:" + key(at.path);
      const found = at.kind === "bundled"
        ? (scriptPath ? await resolveBundledFile(scriptPath, at.name, allow, fsp, path, foldCase) : { ok: false as const, code: "GONE" as const })
        : await openableVideoPath(at.path, pathStyle, fsp, allow);
      const size = found.ok ? await regularSize(found.path) : null;
      if (!found.ok || size === null) { lost.add(wanted); continue; }
      let name = named.get(key(found.path));
      if (!name) {
        const base = at.kind === "bundled" ? at.name : path.basename(at.path);
        for (let n = 1; n <= NUMBERED_TRIES && !name; n++) {
          const candidate = numberedName(base, n);
          if (!bundleableName(candidate, allow)) break;
          if (!taken.has(candidate.toLowerCase())) name = candidate;
        }
        if (!name) { lost.add(wanted); continue; }
        taken.add(name.toLowerCase());
        named.set(key(found.path), name);
        sources.push({ name, from: found.path, size });
      }
      holder.location = { kind: "bundled", name };
    }
    return {
      script: scriptName, folder: folderName(scriptName), body: Buffer.from(JSON.stringify(record, null, 2), "utf8"),
      sources, left: lost.size
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
    const stamp = dosStamp(now());
    const total = plan.body.length + plan.sources.reduce((sum, s) => sum + s.size, 0);
    let done = 0;
    let pos = 0;
    const records: ZipRecord[] = [];
    const put = async (bytes: Uint8Array) => { await handle.write(bytes, 0, bytes.length, pos); pos += bytes.length; };
    const whole = async (name: string, data: Buffer, method: number, size: number, crc: number, folder: boolean) => {
      const r = { name: Buffer.from(name, "utf8"), method, crc, size, packed: data.length, folder };
      const offset = pos;
      await put(localHeader(r, stamp));
      await put(data);
      records.push({ ...r, offset });
    };
    const packed = zlib.deflateRawSync(plan.body);
    await whole(plan.script, packed, 8, plan.body.length, crcOf(plan.body, 0), false);
    done += plan.body.length;
    onProgress(done, total);
    if (plan.sources.length) await whole(plan.folder + "/", Buffer.alloc(0), 0, 0, 0, true);
    for (const s of plan.sources) {
      if (signal.aborted) return "cancelled";
      const r = { name: Buffer.from(plan.folder + "/" + s.name, "utf8"), method: 0, crc: 0, size: s.size, packed: s.size, folder: false };
      const offset = pos;
      await put(localHeader(r, stamp));
      let crc = 0;
      let read = 0;
      const stream = fs.createReadStream(s.from, { highWaterMark: READ_CHUNK });
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          if (signal.aborted) return "cancelled";
          read += chunk.length;
          if (read > s.size) return "failed";
          crc = crcOf(chunk, crc);
          await put(chunk);
          done += chunk.length;
          onProgress(done, total);
        }
      } finally { stream.destroy(); }
      if (read !== s.size) return "failed";
      const at = Buffer.alloc(4);
      at.writeUInt32LE(crc >>> 0, 0);
      await handle.write(at, 0, 4, offset + 14);
      records.push({ ...r, crc, offset });
    }
    if (signal.aborted) return "cancelled";
    const cdOffset = pos;
    for (const r of records) await put(centralHeader(r, stamp));
    await put(endRecords(records.length, cdOffset, pos - cdOffset));
    return "done";
  }

  async function write(plan: BundleExportLayout, target: string, signal: AbortSignal, onProgress: BundleProgress): Promise<BundleExportResult> {
    if (signal.aborted) return { ok: false, code: "CANCELLED" };
    const part = partIn(path.dirname(target));
    let handle: NodeFsPromises.FileHandle;
    try { handle = await fsp.open(part, "wx"); } catch { return { ok: false, code: "FAILED" }; }
    let wrote: "done" | "cancelled" | "failed";
    let published: "copied" | "taken" | "cancelled" | "failed" = "failed";
    try {
      try { wrote = await writeZip(handle, plan, signal, onProgress); } catch { wrote = signal.aborted ? "cancelled" : "failed"; }
      try { await handle.close(); } catch { wrote = "failed"; }
      if (wrote === "done") published = await publishWhole(part, target, signal);
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
