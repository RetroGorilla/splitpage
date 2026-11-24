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

type NativeReplicaFileSystem = Pick<typeof fs, "mkdir" | "open" | "readFile" | "rename" | "rm"> & {
  readonly syncDirectory: (dir: string) => Promise<void>;
};
const MAX_REPLICA_UPDATE_BYTES = 32_000_000;
const MAX_REPLICA_JOURNAL_BYTES = 16_000_000;
const JOURNAL_RECORD_FLAG = 0x80000000;
const RECORD_FORMAT_V2 = 2;
const V2_PREFIX_BYTES = 8;
const MAX_V2_PAYLOAD_BYTES = V2_PREFIX_BYTES + MAX_REPLICA_UPDATE_BYTES + MAX_REPLICA_JOURNAL_BYTES;
const HEADER_FIELDS_BYTES = 12;
const HEADER_BYTES = 20;
const EMPTY = Buffer.alloc(0);
const EMPTY_BYTES = new Uint8Array(0);

interface UnpackedReplicaEntry extends NativeReplicaEntry {
  readonly totalBytes: number;
}

function pack({ generation, bytes, journal }: NativeReplicaEntry): Buffer {
  if (!journal) {
    const record = Buffer.allocUnsafe(HEADER_BYTES + bytes.byteLength);
    record.writeUInt32LE(bytes.byteLength, 0);
    record.writeBigUInt64LE(BigInt(generation), 4);
    record.writeUInt32LE(crc32(record.subarray(0, HEADER_FIELDS_BYTES)), HEADER_FIELDS_BYTES);
    record.writeUInt32LE(crc32(bytes), HEADER_FIELDS_BYTES + 4);
    record.set(bytes, HEADER_BYTES);
    return record;
  }
  const payloadLength = V2_PREFIX_BYTES + bytes.byteLength + journal.byteLength;
  const record = Buffer.allocUnsafe(HEADER_BYTES + payloadLength);
  record.writeUInt32LE((payloadLength | JOURNAL_RECORD_FLAG) >>> 0, 0);
  record.writeBigUInt64LE(BigInt(generation), 4);
  record.writeUInt32LE(crc32(record.subarray(0, HEADER_FIELDS_BYTES)), HEADER_FIELDS_BYTES);
  const payload = record.subarray(HEADER_BYTES);
  payload.writeUInt32LE(RECORD_FORMAT_V2, 0);
  payload.writeUInt32LE(bytes.byteLength, 4);
  payload.set(bytes, V2_PREFIX_BYTES);
  payload.set(journal, V2_PREFIX_BYTES + bytes.byteLength);
  record.writeUInt32LE(crc32(payload), HEADER_FIELDS_BYTES + 4);
  return record;
}

function unpack(file: Buffer, offset: number, checkpoint: boolean): UnpackedReplicaEntry | undefined {
  if (file.length - offset < HEADER_BYTES) return;
  const header = file.subarray(offset, offset + HEADER_BYTES);
  if (crc32(header.subarray(0, HEADER_FIELDS_BYTES)) !== header.readUInt32LE(HEADER_FIELDS_BYTES)) {
    throw new Error("Invalid native replica record header checksum");
  }
  const rawLength = header.readUInt32LE(0);
  const isV2 = rawLength >= JOURNAL_RECORD_FLAG;
  const length = isV2 ? rawLength - JOURNAL_RECORD_FLAG : rawLength;
  const generation = Number(header.readBigUInt64LE(4));
  if (!isV2) {
    if (!Number.isSafeInteger(generation) || generation < 1 || length < 1 || length > MAX_REPLICA_UPDATE_BYTES) {
      throw new Error("Invalid native replica record");
    }
    const end = offset + HEADER_BYTES + length;
    if (end > file.length) return;
    const payload = file.subarray(offset + HEADER_BYTES, end);
    if (crc32(payload) !== header.readUInt32LE(HEADER_FIELDS_BYTES + 4)) {
      throw new Error("Invalid native replica record payload checksum");
    }
    return { generation, checkpoint, bytes: new Uint8Array(payload), totalBytes: HEADER_BYTES + length };
  }
  if (!Number.isSafeInteger(generation) || generation < 0 || length < V2_PREFIX_BYTES + 1 || length > MAX_V2_PAYLOAD_BYTES) {
    throw new Error("Invalid native replica record");
  }
  const end = offset + HEADER_BYTES + length;
  if (end > file.length) return;
  const payload = file.subarray(offset + HEADER_BYTES, end);
  if (crc32(payload) !== header.readUInt32LE(HEADER_FIELDS_BYTES + 4)) {
    throw new Error("Invalid native replica record payload checksum");
  }
  if (payload.readUInt32LE(0) !== RECORD_FORMAT_V2) {
    throw new Error("Unsupported native replica record format");
  }
  const replicaLength = payload.readUInt32LE(4);
  const journalLength = length - V2_PREFIX_BYTES - replicaLength;
  if (replicaLength > MAX_REPLICA_UPDATE_BYTES || journalLength < 1 || journalLength > MAX_REPLICA_JOURNAL_BYTES
    || (checkpoint && (replicaLength < 1 || generation < 1))
    || (!checkpoint && replicaLength > 0 && generation < 1)) {
    throw new Error("Invalid native replica record");
  }
  const bytes = replicaLength > 0 ? new Uint8Array(payload.subarray(V2_PREFIX_BYTES, V2_PREFIX_BYTES + replicaLength)) : EMPTY_BYTES;
  const journal = new Uint8Array(payload.subarray(V2_PREFIX_BYTES + replicaLength));
  return { generation, checkpoint, bytes, journal, totalBytes: HEADER_BYTES + length };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function useFile<T>(handle: NodeFs.FileHandle, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  finally { await handle.close(); }
}

async function syncDirectory(dir: string): Promise<void> {
  // why: Windows does not support opening a directory with Node's file-open flags
  if (process.platform === "win32") return;
  const handle = await fs.open(dir, "r");
  await useFile(handle, () => handle.sync());
}

const systemDisk: NativeReplicaFileSystem = { ...fs, syncDirectory };

function createNativeReplicaFiles(userData: string, disk: NativeReplicaFileSystem = systemDisk) {
  const root = join(userData, "native-replicas");
  const directory = (name: string) => join(root, createHash("sha256").update(name).digest("hex"));

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

  async function syncFile(file: string): Promise<void> {
    const handle = await disk.open(file, "r+");
    await useFile(handle, () => handle.sync());
  }

  async function syncEntry(file: string, dir: string): Promise<void> {
    if (process.platform === "win32") await syncFile(file);
    await disk.syncDirectory(dir);
  }

  async function syncParentDirectories(): Promise<void> {
    await disk.syncDirectory(userData);
    await disk.syncDirectory(root);
  }

  async function open(name: string) {
    const dir = directory(name);
    const snapshot = join(dir, "checkpoint"), log = join(dir, "updates"), journalFile = join(dir, "journal");
    const saved = await read(snapshot);
    const unpackedCheckpoint = saved ? unpack(saved, 0, true) : undefined;
    if (saved && (!unpackedCheckpoint || saved.length !== unpackedCheckpoint.totalBytes)) {
      throw new Error("Invalid native replica checkpoint");
    }
    let checkpoint: NativeReplicaEntry | undefined = unpackedCheckpoint
      ? { generation: unpackedCheckpoint.generation, checkpoint: true, bytes: unpackedCheckpoint.bytes }
      : undefined;
    const logContents = await read(log);
    const contents = logContents ?? EMPTY;
    const savedJournal = await read(journalFile);
    if (savedJournal && savedJournal.byteLength > MAX_REPLICA_JOURNAL_BYTES) {
      throw new Error("Invalid native replica journal");
    }
    let tail: NativeReplicaEntry[] = [];
    let length = 0;
    let previous = 0;
    let replicaTailCount = 0;
    const base = checkpoint?.generation ?? 0;
    let lastReplicaGeneration = base;
    let journal: Uint8Array | null = savedJournal
      ? new Uint8Array(savedJournal)
      : (unpackedCheckpoint?.journal ? new Uint8Array(unpackedCheckpoint.journal) : null);
    while (length < contents.length) {
      const entry = unpack(contents, length, false);
      if (!entry) break;
      const storedEntry: NativeReplicaEntry = {
        generation: entry.generation, checkpoint: false, bytes: entry.bytes
      };
      if (entry.bytes.byteLength > 0) {
        if (previous && entry.generation !== previous + 1) throw new Error("Invalid native replica log order");
        if (entry.generation > base) {
          if (replicaTailCount === 0 && entry.generation !== base + 1) throw new Error("Missing native replica log records");
          tail.push(storedEntry);
          replicaTailCount++;
        }
        if (!savedJournal && entry.journal && entry.generation >= base) journal = new Uint8Array(entry.journal);
        previous = entry.generation;
        if (entry.generation > lastReplicaGeneration) lastReplicaGeneration = entry.generation;
      } else {
        if (previous ? entry.generation !== previous : entry.generation > base) {
          throw new Error("Invalid native replica log order");
        }
        if (!savedJournal && entry.generation >= base && entry.journal) {
          journal = new Uint8Array(entry.journal);
        }
        if (previous === 0 && entry.generation > 0) previous = entry.generation;
      }
      length += entry.totalBytes;
    }
    let repair = length !== contents.length;
    let initialized = false;
    let logEntryNeedsSync = true;

    if (saved || logContents || savedJournal) {
      // why: a process can exit after writing a complete record that is still only in the OS cache
      if (saved) await syncFile(snapshot);
      if (logContents) await syncFile(log);
      if (savedJournal) await syncFile(journalFile);
      await syncParentDirectories();
      await disk.syncDirectory(dir);
      initialized = true;
      logEntryNeedsSync = !logContents;
    }

    async function initialize(): Promise<void> {
      if (initialized) return;
      await disk.mkdir(dir, { recursive: true });
      await syncParentDirectories();
      initialized = true;
    }

    async function repairLog(sync = true): Promise<void> {
      // why: an append-only handle cannot truncate a file on Windows
      const handle = await disk.open(log, "r+");
      await useFile(handle, async () => {
        await handle.truncate(length);
        if (sync) await handle.sync();
      });
      repair = false;
    }

    async function syncLogEntry(): Promise<void> {
      if (!logEntryNeedsSync) return;
      await syncEntry(log, dir);
      logEntryNeedsSync = false;
    }

    // why: the recovered prefix is durable, and a failed recovery sync must leave the original tail intact
    if (repair) await repairLog(false);

    async function append(entry: NativeReplicaEntry): Promise<void> {
      if (repair) await repairLog();
      const replicaEntry: NativeReplicaEntry = { generation: entry.generation, checkpoint: false, bytes: entry.bytes };
      const record = pack(replicaEntry);
      const handle = await disk.open(log, "a+");
      repair = true;
      try {
        await useFile(handle, async () => {
          await handle.writeFile(record);
          await handle.sync();
        });
        await syncLogEntry();
      } catch (error) {
        await repairLog().catch(() => {});
        throw error;
      }
      repair = false;
      length += record.byteLength;
      tail.push(replicaEntry);
      if (replicaEntry.bytes.byteLength > 0) lastReplicaGeneration = replicaEntry.generation;
    }

    async function saveJournalFile(bytes: Uint8Array): Promise<void> {
      const copy = new Uint8Array(bytes);
      await replace(journalFile, copy);
      await syncEntry(journalFile, dir);
      journal = copy;
    }

    async function compact(entry: NativeReplicaEntry): Promise<void> {
      const nextCheckpoint: NativeReplicaEntry = {
        generation: entry.generation, checkpoint: true, bytes: entry.bytes
      };
      // why: the original log must cover the checkpoint until its rename is durable
      await replace(snapshot, pack(nextCheckpoint));
      await syncEntry(snapshot, dir);
      checkpoint = nextCheckpoint;
      if (nextCheckpoint.generation > lastReplicaGeneration) lastReplicaGeneration = nextCheckpoint.generation;
      tail = tail.filter(item => item.generation > nextCheckpoint.generation);
      const keep = Buffer.concat(tail.map(pack));
      await replace(log, keep);
      length = keep.byteLength;
      repair = false;
      logEntryNeedsSync = true;
      await syncLogEntry();
      if (entry.journal) await saveJournalFile(entry.journal);
    }

    const membership = join(dir, "membership");
    return {
      readMembership: () => read(membership),
      async writeMembership(bytes: Uint8Array): Promise<void> {
        await initialize();
        await replace(membership, bytes);
        await syncEntry(membership, dir);
      },
      read(through: number | null) {
        return (checkpoint ? [checkpoint, ...tail] : tail.slice())
          .filter(entry => entry.bytes.byteLength > 0 && (through === null || entry.generation <= through))
          .map(({ generation, checkpoint: isCheckpoint, bytes }) => ({ generation, checkpoint: isCheckpoint, bytes }));
      },
      readJournal: () => journal ? new Uint8Array(journal) : null,
      async writeJournal(bytes: Uint8Array): Promise<void> {
        await initialize();
        await saveJournalFile(bytes);
      },
      async write(entry: NativeReplicaEntry): Promise<void> {
        const base = checkpoint?.generation ?? 0;
        const last = lastReplicaGeneration;
        if (entry.checkpoint ? entry.generation < base || entry.generation > last + 1 : entry.generation !== last + 1) {
          throw new Error("Invalid native replica generation");
        }
        await initialize();
        if (entry.checkpoint) await compact(entry);
        else {
          await append(entry);
          if (entry.journal) await saveJournalFile(entry.journal);
        }
      }
    };
  }

  async function remove(name: string): Promise<void> {
    const dir = directory(name), discarded = dir + ".deleted";
    await disk.rm(discarded, { recursive: true, force: true });
    try { await disk.rename(dir, discarded); }
    catch (error) { if (missing(error)) return; throw error; }
    await disk.syncDirectory(root);
    await disk.rm(discarded, { recursive: true, force: true });
  }

  return { open, remove };
}

export type { createNativeReplicaFiles, NativeReplicaFileSystem };
module.exports = { createNativeReplicaFiles, MAX_REPLICA_UPDATE_BYTES, MAX_REPLICA_JOURNAL_BYTES };
