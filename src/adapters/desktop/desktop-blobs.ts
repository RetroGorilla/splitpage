import type { DesktopPort } from "./desktop-port.ts";
import { setBackend as setBlobBackend } from "../storage/02c-blobs.ts";

const DESKTOP_BLOB_MISSING_SLICE = 2000;

let wiredBlobBridge: Partial<Pick<DesktopPort, "blobPut" | "blobGet" | "blobMissing">> | null = null;

export function wireDesktopBlobs(bridge: Partial<Pick<DesktopPort, "blobPut" | "blobGet" | "blobMissing">> | null) {
  if (bridge && bridge === wiredBlobBridge) return;
  const backend = makeDesktopBlobBackend(bridge);
  if (!backend && !wiredBlobBridge) return;
  wiredBlobBridge = backend ? bridge : null;
  setBlobBackend(backend);
}

export function makeDesktopBlobBackend(bridge: Partial<Pick<DesktopPort, "blobPut" | "blobGet" | "blobMissing">> | null): (NonNullable<Parameters<typeof setBlobBackend>[0]> & { kind: string }) | null {
  const b = bridge;
  if (!b || typeof b.blobPut !== "function" || typeof b.blobGet !== "function" || typeof b.blobMissing !== "function") {
    return null;
  }
  return {
    name: "desktop",
    kind: "desktop",
    persistent: true,
    get: function (sha: string) {
      return Promise.resolve()
        .then(function () { return (b.blobGet as DesktopPort["blobGet"])(sha); })
        .then(function (got) {
          if (!got || !got.bytes || typeof got.mime !== "string") return null;
          const bytes = got.bytes instanceof Uint8Array ? got.bytes : new Uint8Array(got.bytes);
          return { bytes: bytes, mime: got.mime };
        }, function () { return null; });
    },
    put: function (sha: string, bytes: Uint8Array) {
      return Promise.resolve()
        .then(function () { return (b.blobPut as DesktopPort["blobPut"])(sha, bytes); })
        .then(function (res) {
          if (res && res.ok === true) return { stored: res.stored === true };
          const code = (res && typeof res.code === "string" && res.code) || "FAILED";
          const err = new Error("blob-put refused: " + code);
          (err as Error & { code: string }).code = code;
          throw err;
        });
    },
    missing: function (shas: readonly string[]) {
      const list = Array.isArray(shas) ? shas : [];
      const slices = [];
      for (let i = 0; i < list.length; i += DESKTOP_BLOB_MISSING_SLICE) {
        slices.push(list.slice(i, i + DESKTOP_BLOB_MISSING_SLICE));
      }
      return slices.reduce(function (acc, slice) {
        return acc.then(function (out) {
          return Promise.resolve((b.blobMissing as DesktopPort["blobMissing"])(slice)).then(function (m) {
            return out.concat(Array.isArray(m) ? m : slice);
          });
        });
      }, Promise.resolve<string[]>([]));
    }
  };
}
