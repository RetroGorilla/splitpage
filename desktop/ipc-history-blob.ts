"use strict";

import type { DesktopWireHistoryPut } from "../shared/desktop-contract.d.ts";

import type { DesktopHistoryStoreBoundary, DesktopHistoryBlobIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { DesktopFileService } from "./file-service.ts";
import type {
  imageBlobRefusal as BlobImageRefusal, sniffImageMime as BlobMimeSniff,
  isSha256 as BlobShaCheck, MAX_MISSING_QUERY as BlobMissingLimit
} from "./blob-store.ts";

const { toBuffer }: DesktopFileService = require("./file-service.ts");
const { imageBlobRefusal, sniffImageMime, isSha256, MAX_MISSING_QUERY }: {
  imageBlobRefusal: typeof BlobImageRefusal;
  sniffImageMime: typeof BlobMimeSniff;
  isSha256: typeof BlobShaCheck;
  MAX_MISSING_QUERY: typeof BlobMissingLimit;
} = require("./blob-store.ts");

function createHistoryBlobIpc({
  historyStore, historyHolds, historyProtectList, historyWireMeta, blobStore, historyPolicy, DOC_ID_RE
}: DesktopHistoryBlobIpcDependencies) {
  const { HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE, historyUtf8Length, sanitizeHistoryMeta } = historyPolicy;
  function registerHistoryBlobIpc({ ipcHandle }: Parameters<DesktopRegisterIpcGroup>[0]) {
    const historyDocIdArg = (v: unknown) => {
      if (typeof v !== "string" || !DOC_ID_RE.test(v)) throw new Error("history: invalid document id");
      return v;
    };

    ipcHandle("splitpage:history-put", async (event, docId, meta, stateJson, opts) => {
      const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
      const older = o.older === true;
      if (older) {
        if (docId !== null) throw new Error("history: an Older put names no document");
      } else {
        historyDocIdArg(docId);
      }
      const clean = sanitizeHistoryMeta(meta);
      if (!clean) throw new Error("history: invalid snapshot meta");
      if (typeof stateJson !== "string") throw new Error("history: invalid snapshot body");
      const held = historyProtectList(o.protect);
      historyHolds.set(event.sender.id, held);
      const r = older
        ? await (historyStore() as DesktopHistoryStoreBoundary).put(null, clean, stateJson, { protect: held, older: true })
        : await (historyStore() as DesktopHistoryStoreBoundary).put(docId, clean, stateJson, { protect: held });
      if (r.stored) {
        return {
          ok: true,
          sizeBytes: historyUtf8Length(stateJson),
          duplicate: !!r.duplicate,
          evicted: Number(r.evicted) || 0,
          overCap: !!r.overCap
        };
      }
      const out: Extract<DesktopWireHistoryPut, { ok: false }> = { ok: false, code: typeof r.code === "string" ? r.code : "io" };
      if (r.evicted) out.evicted = r.evicted;
      return out;
    });

    ipcHandle("splitpage:history-list", async (event, docId) => {
      const id = docId == null ? null : historyDocIdArg(docId);
      const r = await (historyStore() as DesktopHistoryStoreBoundary).list(id);
      const usage = await (historyStore() as DesktopHistoryStoreBoundary).usage().catch(() => null);
      return {
        entries: r.entries.map(historyWireMeta),
        older: r.older.map(historyWireMeta),
        olderExpiresAt: r.olderExpiresAt,
        usage
      };
    });

    ipcHandle("splitpage:history-get", async (event, query, snapshotId) => {
      const q = query || {};
      const bucket = q.older === true ? HISTORY_OLDER_KEY : historyDocIdArg(q.docId);
      if (typeof snapshotId !== "string" || !HISTORY_SNAP_ID_RE.test(snapshotId)) {
        throw new Error("history: invalid snapshot id");
      }
      if (Array.isArray(q.protect)) historyHolds.set(event.sender.id, historyProtectList(q.protect));
      const r = await (historyStore() as DesktopHistoryStoreBoundary).get(bucket, snapshotId);
      return r ? { meta: historyWireMeta(r.meta), stateJson: r.stateJson } : null;
    });

    ipcHandle("splitpage:history-copy", async (event, fromDocId, toDocId) => {
      historyDocIdArg(fromDocId);
      historyDocIdArg(toDocId);
      if (fromDocId === toDocId) return { ok: true, copied: 0 };
      return (historyStore() as DesktopHistoryStoreBoundary).copy(fromDocId, toDocId);
    });

    ipcHandle("splitpage:history-touch", async (event, docId, title) => {
      historyDocIdArg(docId);
      await (historyStore() as DesktopHistoryStoreBoundary).touch(docId, title);
    });

    ipcHandle("splitpage:history-list-docs", async () => {
      return (historyStore() as DesktopHistoryStoreBoundary).listDocs();
    });

    ipcHandle("splitpage:blob-put", async (event, sha, bytes) => {
      if (typeof bytes === "string") return { ok: false, code: "BAD_BYTES" };
      let buf;
      try { buf = toBuffer(bytes); } catch { return { ok: false, code: "BAD_BYTES" }; }
      const refusal = imageBlobRefusal(buf);
      if (refusal) return { ok: false, code: refusal };
      if (!blobStore()) return { ok: false, code: "UNAVAILABLE" };
      return (blobStore() as NonNullable<ReturnType<typeof blobStore>>).put(sha, buf);
    });

    ipcHandle("splitpage:blob-get", async (event, sha) => {
      if (!blobStore()) return null;
      const buf = await (blobStore() as NonNullable<ReturnType<typeof blobStore>>).get(sha);
      if (!buf) return null;
      const mime = sniffImageMime(buf);
      return mime ? { bytes: buf, mime } : null;
    });

    ipcHandle("splitpage:blob-missing", async (event, shas) => {
      if (shas.length > MAX_MISSING_QUERY) throw new Error("blob-missing: at most " + MAX_MISSING_QUERY + " shas per call");
      if (!shas.every(isSha256)) throw new Error("blob-missing: every entry must be a sha256");
      if (!blobStore()) return [...new Set(shas)];
      return (blobStore() as NonNullable<ReturnType<typeof blobStore>>).missing(shas);
    });
  }

  return { registerHistoryBlobIpc };
}

export type { createHistoryBlobIpc };

module.exports = { createHistoryBlobIpc };
