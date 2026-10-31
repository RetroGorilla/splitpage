"use strict";

const { toBuffer } = require("./file-service");
const { imageBlobRefusal, sniffImageMime, isSha256, MAX_MISSING_QUERY } = require("./blob-store");

function createHistoryBlobIpc({
  historyStore, historyHolds, historyProtectList, historyWireMeta, blobStore, historyPolicy, DOC_ID_RE
}) {
  const { HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE, historyUtf8Length, sanitizeHistoryMeta } = historyPolicy;
  function registerHistoryBlobIpc({ ipcHandle }) {
    const historyDocIdArg = (v) => {
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
        ? await historyStore().put(null, clean, stateJson, { protect: held, older: true })
        : await historyStore().put(docId, clean, stateJson, { protect: held });
      if (r.stored) {
        return {
          ok: true,
          sizeBytes: historyUtf8Length(stateJson),
          duplicate: !!r.duplicate,
          evicted: Number(r.evicted) || 0,
          overCap: !!r.overCap
        };
      }
      const out = { ok: false, code: typeof r.code === "string" ? r.code : "io" };
      if (r.evicted) out.evicted = r.evicted;
      return out;
    });

    ipcHandle("splitpage:history-list", async (event, docId) => {
      const id = docId == null ? null : historyDocIdArg(docId);
      const r = await historyStore().list(id);
      const usage = await historyStore().usage().catch(() => null);
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
      const r = await historyStore().get(bucket, snapshotId);
      return r ? { meta: historyWireMeta(r.meta), stateJson: r.stateJson } : null;
    });

    ipcHandle("splitpage:history-copy", async (event, fromDocId, toDocId) => {
      historyDocIdArg(fromDocId);
      historyDocIdArg(toDocId);
      if (fromDocId === toDocId) return { ok: true, copied: 0 };
      return historyStore().copy(fromDocId, toDocId);
    });

    ipcHandle("splitpage:history-touch", async (event, docId, title) => {
      historyDocIdArg(docId);
      await historyStore().touch(docId, title);
    });

    ipcHandle("splitpage:history-list-docs", async () => {
      return historyStore().listDocs();
    });

    ipcHandle("splitpage:blob-put", async (event, sha, bytes) => {
      if (typeof bytes === "string") return { ok: false, code: "BAD_BYTES" };
      let buf;
      try { buf = toBuffer(bytes); } catch { return { ok: false, code: "BAD_BYTES" }; }
      const refusal = imageBlobRefusal(buf);
      if (refusal) return { ok: false, code: refusal };
      if (!blobStore()) return { ok: false, code: "UNAVAILABLE" };
      return blobStore().put(sha, buf);
    });

    ipcHandle("splitpage:blob-get", async (event, sha) => {
      if (!blobStore()) return null;
      const buf = await blobStore().get(sha);
      if (!buf) return null;
      const mime = sniffImageMime(buf);
      return mime ? { bytes: buf, mime } : null;
    });

    ipcHandle("splitpage:blob-missing", async (event, shas) => {
      if (shas.length > MAX_MISSING_QUERY) throw new Error("blob-missing: at most " + MAX_MISSING_QUERY + " shas per call");
      if (!shas.every(isSha256)) throw new Error("blob-missing: every entry must be a sha256");
      if (!blobStore()) return [...new Set(shas)];
      return blobStore().missing(shas);
    });
  }

  return { registerHistoryBlobIpc };
}

module.exports = { createHistoryBlobIpc };
