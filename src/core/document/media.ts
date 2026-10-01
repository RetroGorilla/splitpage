import { imageDims, isSha256Hex, normalizeImageRef, sniffImageMime } from "../../../shared/blob-policy.js";
import { mediaCommentId, sha256Bytes } from "./ids.ts";
import type { ImageRef, ImageSource } from "./ports.ts";
import { safeHref, safeImageSrc, storedImageHtml, storedImageMarkup } from "./text-policy.ts";

export interface RowImage {
  ref: ImageRef | null;
  dataUrl: string | null;
}

export interface ImageRow {
  visualImage?: unknown;
  imageRef?: unknown;
}

export interface DecodedImage {
  ref: ImageRef;
  bytes: Uint8Array;
}

export interface ImageIngestion extends ImageSource {
  pending(): DecodedImage[];
}

export type MediaField = "visualText" | "audioText";

export interface CellMedia {
  kind: string;
  ref?: Readonly<Record<string, unknown>> | null | undefined;
  href?: string | null | undefined;
}

export interface MediaRow {
  id: string;
  updatedAt?: string | null | undefined;
}

export interface MediaComment {
  id: string;
  rowId: string;
  field: MediaField;
  anchorId: null;
  quotedText: string;
  author: string;
  body: string;
  resolved: boolean;
  resolvedBy: null;
  resolvedAt: null;
  assignee: string;
  createdAt: string;
  updatedAt: string;
  kind: "anchor";
  replies: unknown[];
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

let B64_LOOKUP: Uint8Array | null = null;

export function forgivingBase64Decode(text: string): Uint8Array | null {
  let s = text.replace(/[\t\n\f\r ]/g, "");
  if (s.length % 4 === 0) s = s.replace(/={1,2}$/, "");
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) return null;
  if (!B64_LOOKUP) {
    B64_LOOKUP = new Uint8Array(128);
    for (let k = 0; k < 64; k++) B64_LOOKUP[B64_ALPHABET.charCodeAt(k)] = k;
  }
  const lookup = B64_LOOKUP;
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let buf = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    buf = ((buf << 6) | (lookup[s.charCodeAt(i)] as number)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

export function base64Encode(bytes: ArrayLike<number>): string {
  const parts: string[] = [];
  let chunk = "", i, n, a, b, c;
  for (i = 0; i + 2 < bytes.length; i += 3) {
    n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    chunk += B64_ALPHABET.charAt(n >> 18) + B64_ALPHABET.charAt((n >> 12) & 63) +
      B64_ALPHABET.charAt((n >> 6) & 63) + B64_ALPHABET.charAt(n & 63);
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ""; }
  }
  if (i < bytes.length) {
    a = bytes[i] as number; b = i + 1 < bytes.length ? bytes[i + 1] as number : 0; c = 0;
    n = (a << 16) | (b << 8) | c;
    chunk += B64_ALPHABET.charAt(n >> 18) + B64_ALPHABET.charAt((n >> 12) & 63) +
      (i + 1 < bytes.length ? B64_ALPHABET.charAt((n >> 6) & 63) : "=") + "=";
  }
  parts.push(chunk);
  return parts.join("");
}

export function imageRecordOf(bytes: Uint8Array): ImageRef | null {
  const mime: string | null = sniffImageMime(bytes);
  const size: { width: number; height: number } | null = mime ? imageDims(bytes) : null;
  if (!mime || !size) return null;
  const sha = sha256Bytes(bytes);
  return { sha256: sha, width: size.width, height: size.height, mime: mime };
}

export function imageDataUrlBytes(dataUrl: unknown): Uint8Array | null {
  if (typeof dataUrl !== "string" || !safeImageSrc(dataUrl)) return null;
  const url = dataUrl.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, "");
  return forgivingBase64Decode(url.slice(url.indexOf(",") + 1));
}

export function decodeImageDataUrl(dataUrl: unknown): DecodedImage | null {
  const bytes = imageDataUrlBytes(dataUrl);
  const ref = bytes ? imageRecordOf(bytes) : null;
  return bytes && ref ? { ref: ref, bytes: bytes } : null;
}

function freshRef(ref: ImageRef): ImageRef {
  return { sha256: ref.sha256, width: ref.width, height: ref.height, mime: ref.mime };
}

export function createImageIngestion(known: (sha: string) => ImageRef | null): ImageIngestion {
  const pending: Record<string, DecodedImage> = Object.create(null);
  const order: string[] = [];
  return {
    known: function (sha) {
      const held = pending[sha];
      return held ? freshRef(held.ref) : known(sha);
    },
    fromDataUrl: function (url) {
      const decoded = decodeImageDataUrl(url);
      if (!decoded) return null;
      const sha = decoded.ref.sha256;
      if (!pending[sha]) {
        pending[sha] = decoded;
        order.push(sha);
      }
      return freshRef(decoded.ref);
    },
    pending: function () {
      return order.map(function (sha) {
        const held = pending[sha] as DecodedImage;
        return { ref: freshRef(held.ref), bytes: held.bytes.slice() };
      });
    }
  };
}

function legacyImageSrc(row: ImageRow): string | null {
  const v = row.visualImage;
  return typeof v === "string" && v.slice(0, 11) === "data:image/" ? v : null;
}

export function rowImage(row: unknown): RowImage | null {
  if (!row || typeof row !== "object") return null;
  const legacy = legacyImageSrc(row as ImageRow);
  if (legacy) return { ref: null, dataUrl: legacy };
  const ref: ImageRef | null = normalizeImageRef((row as ImageRow).imageRef);
  return ref ? { ref: ref, dataUrl: null } : null;
}

export function rowImageKey(row: unknown): string | null {
  const img = rowImage(row);
  return img ? (img.ref ? img.ref.sha256 : img.dataUrl) : null;
}

export function rowImageShas(rows: unknown): string[] {
  const out: string[] = [], seen: Record<string, boolean> = {};
  (Array.isArray(rows) ? rows as unknown[] : []).forEach(function (row) {
    const img = rowImage(row);
    if (!img || !img.ref || seen[img.ref.sha256]) return;
    seen[img.ref.sha256] = true;
    out.push(img.ref.sha256);
  });
  return out;
}

const MEDIA_COMMENT_NOTE: Record<MediaField, string> = {
  visualText: "This was in the scene's visual column. Pictures and videos go in comments now:",
  audioText: "This was in the scene's audio column. Pictures and videos go in comments now:"
};

export function mediaComments(row: MediaRow, field: MediaField, found: readonly CellMedia[], images: ImageSource, videoCardHtml: (href: string) => string): MediaComment[] {
  const out: MediaComment[] = [];
  const seen: Record<string, boolean> = Object.create(null);
  found.forEach(function (m) {
    let key, media;
    if (m.kind === "image") {
      const sha: unknown = m.ref && m.ref.sha256;
      if (!isSha256Hex(sha)) return;
      key = "img:" + (sha as string);
      const rec = images.known(sha as string) || normalizeImageRef(m.ref);
      media = rec ? storedImageHtml(rec) : storedImageMarkup({ sha256: sha as string });
    } else {
      const href = safeHref(m.href || "");
      if (!href) return;
      key = "video:" + href;
      media = videoCardHtml(href);
    }
    const id = mediaCommentId(row.id, field, key);
    if (seen[id]) return;
    seen[id] = true;
    out.push({
      id: id,
      rowId: row.id,
      field: field,
      anchorId: null,
      quotedText: "",
      author: "Splitpage",
      body: MEDIA_COMMENT_NOTE[field] + "<br>" + media,
      resolved: false,
      resolvedBy: null,
      resolvedAt: null,
      assignee: "",
      createdAt: row.updatedAt || "",
      updatedAt: row.updatedAt || "",
      kind: "anchor",
      replies: []
    });
  });
  return out;
}
