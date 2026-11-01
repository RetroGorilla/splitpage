import { setBackend as setBlobBackend } from "../storage/02c-blobs.ts";

var DESKTOP_BLOB_MISSING_SLICE = 2000;

var wiredBlobBridge = null;

export function wireDesktopBlobs(bridge) {
  if (bridge && bridge === wiredBlobBridge) return;
  var backend = makeDesktopBlobBackend(bridge);
  if (!backend && !wiredBlobBridge) return;
  wiredBlobBridge = backend ? bridge : null;
  setBlobBackend(backend);
}

export function makeDesktopBlobBackend(bridge) {
  var b = bridge;
  if (!b || typeof b.blobPut !== "function" || typeof b.blobGet !== "function" || typeof b.blobMissing !== "function") {
    return null;
  }
  return {
    name: "desktop",
    kind: "desktop",
    persistent: true,
    get: function (sha) {
      return Promise.resolve()
        .then(function () { return b.blobGet(sha); })
        .then(function (got) {
          if (!got || !got.bytes || typeof got.mime !== "string") return null;
          var bytes = got.bytes instanceof Uint8Array ? got.bytes : new Uint8Array(got.bytes);
          return { bytes: bytes, mime: got.mime };
        }, function () { return null; });
    },
    put: function (sha, bytes) {
      return Promise.resolve()
        .then(function () { return b.blobPut(sha, bytes); })
        .then(function (res) {
          if (res && res.ok === true) return { stored: res.stored === true };
          var code = (res && typeof res.code === "string" && res.code) || "FAILED";
          var err = new Error("blob-put refused: " + code);
          err.code = code;
          throw err;
        });
    },
    missing: function (shas) {
      var list = Array.isArray(shas) ? shas : [];
      var slices = [];
      for (var i = 0; i < list.length; i += DESKTOP_BLOB_MISSING_SLICE) {
        slices.push(list.slice(i, i + DESKTOP_BLOB_MISSING_SLICE));
      }
      return slices.reduce(function (acc, slice) {
        return acc.then(function (out) {
          return Promise.resolve(b.blobMissing(slice)).then(function (m) {
            return out.concat(Array.isArray(m) ? m : slice);
          });
        });
      }, Promise.resolve([]));
    }
  };
}
