import { concatBytes, strBytes } from "./bytes.ts";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export interface ZipReader {
  get: (name: string) => Promise<Uint8Array | null>;
  names: string[];
}

interface StoredEntry {
  method: number;
  raw: Uint8Array;
}

const DEFAULT_DOS_DATE = 0x21;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  const table = crcTable;
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = (table[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

export function zipWrite(entries: readonly ZipEntry[], day?: Date | null): Uint8Array<ArrayBuffer> {
  const dosTime = 0;
  const dosDate = day
    ? (((day.getFullYear() - 1980) & 0x7f) << 9) | (((day.getMonth() + 1) & 0xf) << 5) | (day.getDate() & 0x1f)
    : DEFAULT_DOS_DATE;

  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = strBytes(e.name);
    const crc = crc32(e.data);
    const lh = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(nameB.length), u16(0), nameB
    ]);
    local.push(lh, e.data);
    central.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB
    ]));
    offset += lh.length + e.data.length;
  }

  const cd = concatBytes(central);
  const eocd = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0)
  ]);
  return concatBytes([concatBytes(local), cd, eocd]);
}

async function inflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("no-decompression-stream");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function zipRead(arrayBuffer: ArrayBuffer): Promise<ZipReader> {
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not-a-zip");

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const files: Record<string, StoredEntry> = {};
  let p = cdOffset;

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    files[name] = { method: method, raw: raw };
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    async get(name: string): Promise<Uint8Array | null> {
      const f = Object.prototype.hasOwnProperty.call(files, name) ? files[name] : undefined;
      if (!f) return null;
      return f.method === 0 ? f.raw : await inflateRaw(f.raw as Uint8Array<ArrayBuffer>);
    },
    names: Object.keys(files)
  };
}
