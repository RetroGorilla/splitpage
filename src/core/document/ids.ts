import { normalizeDocId } from "../../../shared/doc-id-policy.js";

export interface DocIdHolder {
  docId?: unknown;
}

const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

export function utf8Bytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length * 3);
  let o = 0;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (n - 0xdc00); i++; }
      else c = 0xfffd;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      c = 0xfffd;
    }
    if (c < 0x80) {
      out[o++] = c;
    } else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 0x3f);
      out[o++] = 0x80 | (c & 0x3f);
    } else {
      out[o++] = 0xf0 | (c >> 18);
      out[o++] = 0x80 | ((c >> 12) & 0x3f);
      out[o++] = 0x80 | ((c >> 6) & 0x3f);
      out[o++] = 0x80 | (c & 0x3f);
    }
  }
  return out.subarray(0, o);
}

function sha256Block(H: number[], w: Int32Array, src: ArrayLike<number>, off: number): void {
  let t, j, x, y, t1, t2;
  for (t = 0; t < 16; t++) {
    j = off + t * 4;
    w[t] = ((src[j] ?? 0) << 24) | ((src[j + 1] ?? 0) << 16) | ((src[j + 2] ?? 0) << 8) | (src[j + 3] ?? 0);
  }
  for (t = 16; t < 64; t++) {
    x = w[t - 2] ?? 0; y = w[t - 15] ?? 0;
    w[t] = ((((x >>> 17) | (x << 15)) ^ ((x >>> 19) | (x << 13)) ^ (x >>> 10)) +
            (w[t - 7] ?? 0) +
            (((y >>> 7) | (y << 25)) ^ ((y >>> 18) | (y << 14)) ^ (y >>> 3)) +
            (w[t - 16] ?? 0)) | 0;
  }
  let a = H[0] ?? 0, b = H[1] ?? 0, c = H[2] ?? 0, d = H[3] ?? 0;
  let e = H[4] ?? 0, f = H[5] ?? 0, g = H[6] ?? 0, h = H[7] ?? 0;
  for (t = 0; t < 64; t++) {
    t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
          ((e & f) ^ (~e & g)) + (SHA256_K[t] ?? 0) + (w[t] ?? 0)) | 0;
    t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
          ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  H[0] = ((H[0] ?? 0) + a) | 0; H[1] = ((H[1] ?? 0) + b) | 0; H[2] = ((H[2] ?? 0) + c) | 0; H[3] = ((H[3] ?? 0) + d) | 0;
  H[4] = ((H[4] ?? 0) + e) | 0; H[5] = ((H[5] ?? 0) + f) | 0; H[6] = ((H[6] ?? 0) + g) | 0; H[7] = ((H[7] ?? 0) + h) | 0;
}

export function sha256Bytes(bytes: ArrayLike<number>): string {
  const len = bytes.length;
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Int32Array(64);
  const full = len - (len % 64);
  let off, t;
  for (off = 0; off < full; off += 64) sha256Block(H, w, bytes, off);
  const rest = len - full;
  const total = rest + 9 <= 64 ? 64 : 128;
  const msg = new Uint8Array(total);
  for (t = 0; t < rest; t++) msg[t] = bytes[full + t] ?? 0;
  msg[rest] = 0x80;
  const hi = Math.floor(len / 0x20000000), lo = (len * 8) >>> 0;
  msg[total - 8] = (hi >>> 24) & 0xff; msg[total - 7] = (hi >>> 16) & 0xff;
  msg[total - 6] = (hi >>> 8) & 0xff;  msg[total - 5] = hi & 0xff;
  msg[total - 4] = (lo >>> 24) & 0xff; msg[total - 3] = (lo >>> 16) & 0xff;
  msg[total - 2] = (lo >>> 8) & 0xff;  msg[total - 1] = lo & 0xff;
  for (off = 0; off < total; off += 64) sha256Block(H, w, msg, off);
  let hex = "";
  for (t = 0; t < 8; t++) hex += ("0000000" + ((H[t] ?? 0) >>> 0).toString(16)).slice(-8);
  return hex;
}

export function sha256Hex(str: unknown): string {
  return sha256Bytes(utf8Bytes(String(str)));
}

export function deriveDocId(domain: unknown, text: unknown): string {
  return "d" + sha256Hex(String(domain) + "\n" + String(text)).slice(0, 32);
}

export function docIdEmbeddedIn(raw: unknown): boolean {
  return !!normalizeDocId(raw && typeof raw === "object" ? (raw as DocIdHolder).docId : null);
}

export function mergedDocId(base: DocIdHolder | null | undefined, mine: DocIdHolder | null | undefined, theirs: DocIdHolder | null | undefined): string {
  const m = normalizeDocId(mine && mine.docId);
  const t = normalizeDocId(theirs && theirs.docId);
  if (m === t) return m;
  if (base && t === normalizeDocId(base.docId)) return m || t;
  return t || m;
}
