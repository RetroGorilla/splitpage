import { isSha256Hex } from "../../../../shared/blob-policy.ts";
import { imageRecordOf } from "../../../core/document/media.ts";

const MAX_BYTES = 16 * 1024 * 1024;

async function readPicture(response: Response, progress?: () => void): Promise<Uint8Array | null> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
      if (value.byteLength) progress?.();
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function refusal(status: number): "access" | "rejected" | "retry" {
  if (status === 401 || status === 403) return "access";
  if (status === 413 || status === 415 || status === 422) return "rejected";
  return "retry";
}

export function sharedPictureHttp(origin: string, script: string, token: string, request = fetch, inactivityMs = 30_000) {
  const base = new URL(origin);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("Invalid picture service origin");
  }
  function picture(sha: string, signal: AbortSignal, upload?: { bytes: Uint8Array; mime: string }) {
    if (!isSha256Hex(sha)) throw new Error("Invalid picture hash");
    const url = new URL("/api/scripts/" + encodeURIComponent(script) + "/pictures/" + sha, base.origin);
    const headers = new Headers({ Authorization: "Bearer " + token });
    if (upload) headers.set("Content-Type", upload.mime);
    return request(url, {
      method: upload ? "PUT" : "GET",
      body: upload ? Uint8Array.from(upload.bytes) : null,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: upload ? AbortSignal.any([signal, AbortSignal.timeout(65_000)]) : signal
    });
  }
  return {
    async upload(sha: string, bytes: Uint8Array, mime: string, signal: AbortSignal) {
      if (bytes.byteLength > MAX_BYTES) return "rejected";
      const response = await picture(sha, signal, { bytes, mime });
      await response.body?.cancel();
      return response.status === 201 || response.status === 204 ? "stored" : refusal(response.status);
    },
    async download(sha: string, signal: AbortSignal, progress?: () => void) {
      signal.throwIfAborted();
      const stall = new AbortController();
      let timer = setTimeout(() => stall.abort(), inactivityMs);
      try {
        const response = await picture(sha, AbortSignal.any([signal, stall.signal]));
        if (response.status !== 200) {
          await response.body?.cancel();
          return refusal(response.status);
        }
        const bytes = await readPicture(response, () => {
          clearTimeout(timer);
          timer = setTimeout(() => stall.abort(), inactivityMs);
          progress?.();
        });
        return bytes && imageRecordOf(bytes)?.sha256 === sha ? bytes : "retry";
      } finally { clearTimeout(timer); }
    }
  };
}
