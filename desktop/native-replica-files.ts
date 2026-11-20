"use strict";

import type * as NodeFs from "node:fs/promises";
import type * as NodeCrypto from "node:crypto";
import type * as NodePath from "node:path";
import type * as NodeZlib from "node:zlib";
import type { NativeReplicaEntry } from "../shared/native-replica.d.ts";

const fs: typeof NodeFs = require("node:fs/promises");
const { createHash }: typeof NodeCrypto = require("node:crypto");
const { join }: typeof NodePath = require("node:path");
const { crc32 }: typeof NodeZlib = require("node:zlib");

type NativeReplicaFileSystem = Pick<typeof fs, "mkdir" | "open" | "readFile" | "rename" | "rm">;
const MAX_REPLICA_UPDATE_BYTES = 32_000_000;
const HEADER_BYTES = 16;
const EMPTY = Buffer.alloc(0);

function checksum(record: Buffer): number {
  return crc32(record.subarray(HEADER_BYTES), crc32(record.subarray(0, 12)));
}

function pack({ generation, bytes }: NativeReplicaEntry): Buffer {
  const record = Buffer.allocUnsafe(HEADER_BYTES + bytes.byteLength);
  record.writeUInt32LE(bytes.byteLength, 0);
  record.writeBigUInt64LE(BigInt(generation), 4);
  record.set(bytes, HEADER_BYTES);
  record.writeUInt32LE(checksum(record), 12);
  return record;
}

function unpack(file: Buffer, offset: number, checkpoint: boolean): NativeReplicaEntry | undefined {
  if (file.length - offset < HEADER_BYTES) return;
  const length = file.readUInt32LE(offset);
  const end = offset + HEADER_BYTES + length;
  if (end > file.length) return;
  const record = file.subarray(offset, end);
  if (checksum(record) !== record.readUInt32LE(12)) {
    if (end === file.length) return;
    throw new Error("Invalid native replica record checksum");
  }
  const generation = Number(record.readBigUInt64LE(4));
  if (!Number.isSafeInteger(generation) || generation < 1 || length < 1 || length > MAX_REPLICA_UPDATE_BYTES) {
    throw new Error("Invalid native replica record");
  }
  return { generation, checkpoint, bytes: new Uint8Array(record.subarray(HEADER_BYTES)) };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function useFile<T>(handle: NodeFs.FileHandle, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  finally { await handle.close(); }
}

function createNativeReplicaFiles(userData: string, disk: NativeReplicaFileSystem = fs) {
  const root = join(userData, "native-replicas");
  const directory = (name: string) => join(root, createHash("sha256").update(name).digest("hex"));

  async function syncDirectory(dir: string): Promise<void> {
    // why: Windows does not support opening a directory with Node's file-open flags
    if (process.platform === "win32") return;
    const handle = await disk.open(dir, "r");
    await useFile(handle, () => handle.sync());
  }

  async function read(file: string): Promise<Buffer | null> {
    try { return await disk.readFile(file); }
    catch (error) { if (missing(error)) return null; throw error; }
  }

  async function replace(file: string, bytes: Uint8Array): Promise<void> {
    const temp = file + ".new";
    const handle = await disk.open(temp, "w");
    await useFile(handle, async () => {
      await handle.writeFile(bytes);
      await handle.sync();
    });
    await disk.rename(temp, file);
  }

  async function open(name: string) {
    const dir = directory(name);
    const snapshot = join(dir, "checkpoint"), log = join(dir, "updates");
    const saved = await read(snapshot);
    let checkpoint = saved ? unpack(saved, 0, true) : undefined;
    if (saved && (!checkpoint || saved.length !== HEADER_BYTES + checkpoint.bytes.byteLength)) {
      throw new Error("Invalid native replica checkpoint");
    }
    const contents = await read(log) ?? EMPTY;
    let tail: NativeReplicaEntry[] = [];
    let length = 0;
    let previous = 0;
    const base = checkpoint?.generation ?? 0;
    while (length < contents.length) {
      const entry = unpack(contents, length, false);
      if (!entry) break;
      if (previous && entry.generation !== previous + 1) throw new Error("Invalid native replica log order");
      if (entry.generation > base) {
        if (tail.length === 0 && entry.generation !== base + 1) throw new Error("Missing native replica log records");
        tail.push(entry);
      }
      previous = entry.generation;
      length += HEADER_BYTES + entry.bytes.byteLength;
    }
    let repair = length !== contents.length;
    let initialized = false;

    async function initialize(): Promise<void> {
      if (initialized) return;
      await disk.mkdir(dir, { recursive: true });
      await syncDirectory(userData);
      await syncDirectory(root);
      initialized = true;
    }

    async function repairLog(): Promise<void> {
      // why: an append-only handle cannot truncate a file on Windows
      const handle = await disk.open(log, "r+");
      await useFile(handle, async () => {
        await handle.truncate(length);
        await handle.sync();
      });
      repair = false;
    }

    if (repair) await repairLog();

    async function append(entry: NativeReplicaEntry): Promise<void> {
      if (repair) await repairLog();
      const record = pack(entry);
      const handle = await disk.open(log, "a+");
      repair = true;
      try {
        await useFile(handle, async () => {
          await handle.writeFile(record);
          await handle.sync();
          if (length === 0) await syncDirectory(dir);
        });
      } catch (error) {
        await repairLog().catch(() => {});
        throw error;
      }
      repair = false;
      length += record.byteLength;
      tail.push(entry);
    }

    async function compact(entry: NativeReplicaEntry): Promise<void> {
      // why: the original log must cover the checkpoint until its rename is durable
      await replace(snapshot, pack(entry));
      await syncDirectory(dir);
      checkpoint = entry;
      tail = tail.filter(item => item.generation > entry.generation);
      const keep = Buffer.concat(tail.map(pack));
      await replace(log, keep);
      length = keep.byteLength;
      repair = false;
      await syncDirectory(dir);
    }

    return {
      read(through: number | null) {
        return (checkpoint ? [checkpoint, ...tail] : tail.slice()).filter(entry => through === null || entry.generation <= through);
      },
      async write(entry: NativeReplicaEntry): Promise<void> {
        const base = checkpoint?.generation ?? 0;
        const last = tail.at(-1)?.generation ?? base;
        if (entry.checkpoint ? entry.generation < base || entry.generation > last + 1 : entry.generation !== last + 1) {
          throw new Error("Invalid native replica generation");
        }
        await initialize();
        if (entry.checkpoint) await compact(entry);
        else await append(entry);
      }
    };
  }

  async function remove(name: string): Promise<void> {
    const dir = directory(name), discarded = dir + ".deleted";
    await disk.rm(discarded, { recursive: true, force: true });
    try { await disk.rename(dir, discarded); }
    catch (error) { if (missing(error)) return; throw error; }
    await syncDirectory(root);
    await disk.rm(discarded, { recursive: true, force: true });
  }

  return { open, remove };
}

export type { createNativeReplicaFiles, NativeReplicaFileSystem };
module.exports = { createNativeReplicaFiles, MAX_REPLICA_UPDATE_BYTES };
