import { HISTORY_OLDER_KEY, HISTORY_SNAP_ID_RE, historyUtf8Length, sanitizeHistoryMeta } from "../../../shared/history-policy.js";
import { normalizeDocId } from "../../../shared/doc-id-policy.js";
import { hashText as historyHashText } from "../storage/03c-history-idb.js";
import { createHistoryStore, createMemoryHistoryBackend } from "../../../shared/history-store.js";
import { strBytes } from "../formats/bytes.ts";

export function makeFakeDesktopBackend(opts) {
  var files = {};
  var recents = [];
  var nextId = 1;
  var openHandler = null;
  var menuHandler = null;
  var restoreNoticeHandler = null;
  var reassignDocIdHandler = null;
  function newId() { return "fake" + (nextId++); }

  var draftStore = { floor: -Infinity, current: null, previous: null, base: null, writes: 0, failures: 0 };
  var draftLog = [];
  var draftTaken = null;
  var flushHandler = null;
  var draftFailNext = null;
  function draftFail(code) {
    if (code !== "HELD" && code !== "NEED_BASE" && code !== "STALE_SEQ" && code !== "DISCARDED") draftStore.failures++;
    draftStore.base = null;
    return Promise.resolve({ ok: false, code: code });
  }

  var backend = {
    isDesktop: true,
    platform: "test",
    appVersion: "0.0.0-test",

    tabId: "f".repeat(32),
    windowId: "w".repeat(32),
    launchIntent: { type: "blank" },
    hadPriorSession: false,
    firstTabOfLaunch: true,
    hasDraftToRestore: false,

    openFileDialog: function () { return Promise.resolve(null); },
    saveFileDialog: function (opts) {
      if (this._cancelNextSave) { this._cancelNextSave = false; return Promise.resolve(null); }
      var id = newId();
      files[id] = { name: (opts && opts.suggestedName) || "untitled", bytes: new Uint8Array(0), lastModified: Date.now() + nextId };
      return Promise.resolve({ id: id, name: files[id].name });
    },
    readFile: function (id) {
      var f = files[id];
      if (!f) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
    },
    writeFile: function (id, data) {
      var f = files[id];
      if (!f) return Promise.reject(new Error("ENOENT"));
      var bytes = data instanceof Uint8Array ? data
        : (data instanceof ArrayBuffer ? new Uint8Array(data)
        : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(0)));
      f.bytes = bytes;
      f.lastModified = Date.now() + (nextId++);
      return Promise.resolve({ lastModified: f.lastModified, size: bytes.length });
    },
    statFile: function (id) {
      var f = files[id];
      return Promise.resolve(f ? { lastModified: f.lastModified, size: f.bytes.length } : null);
    },
    routeOpen: function (p) {
      if (p && p.kind === "file" && this._routeMissing) return Promise.reject(new Error("ENOENT: file is not readable"));
      this._lastRoute = p ? JSON.parse(JSON.stringify(p)) : null;
      return Promise.resolve(this._routeAnswer || { where: "this-tab" });
    },

    listRecents: function () { return Promise.resolve(recents.map(function (r) { return { fileId: r.fileId, name: r.name, title: r.title, at: r.at }; })); },
    removeRecent: function (fileId) {
      recents = recents.filter(function (r) { return r.fileId !== fileId; });
      return this.listRecents();
    },
    clearRecents: function () { recents = []; return this.listRecents(); },
    _addRecent: function (fileId, name, title, at) {
      recents = recents.filter(function (r) { return r.fileId !== fileId; });
      recents.unshift({ fileId: fileId, name: name, title: title || "", at: at || Date.now() });
      return fileId;
    },
    onOpenFile: function (cb) { openHandler = cb; },
    onRestoreNotice: function (cb) { restoreNoticeHandler = cb; },
    onReassignDocId: function (cb) { reassignDocIdHandler = cb; },
    onMenuCommand: function (cb) { menuHandler = cb; },
    setDocumentState: function (s) { this._lastDocState = s; },
    getSessionInfo: function () {
      return Promise.resolve({ library: false, hosting: false, port: null, lanUrls: [], pin: "" });
    },
    openExternal: function (url) { (this._externalOpens = this._externalOpens || []).push(url); },
    grantVideoFile: function (file) {
      this._videoGrants = this._videoGrants || {};
      var token = "t" + Object.keys(this._videoGrants).length;
      this._videoGrants[token] = file && file.name;
      return Promise.resolve(token);
    },
    openVideoFile: function (token) {
      var name = this._videoGrants && this._videoGrants[token];
      if (!name) return Promise.resolve({ ok: false, code: "UNKNOWN" });
      (this._videoOpens = this._videoOpens || []).push(name);
      return Promise.resolve({ ok: true });
    },
    videoThumbnail: function (host, ref) {
      (this._thumbCalls = this._thumbCalls || []).push([host, ref]);
      return Promise.resolve(this._thumbAnswer || { ok: false, code: "UNAVAILABLE" });
    },
    openPrompterInBrowser: function () {
      this._prompterCalls = (this._prompterCalls || 0) + 1;
      this._prompterDocState = this._lastDocState || null;
      return Promise.resolve(this._prompterAnswer || { ok: true, kind: "file" });
    },
    openPrompterInChromium: function () {
      this._chromiumCalls = (this._chromiumCalls || 0) + 1;
      this._chromiumDocState = this._lastDocState || null;
      return Promise.resolve(this._chromiumAnswer || { ok: true, kind: "file", voice: "browser", browser: "Microsoft Edge" });
    },

    writeDraft: function (payload) {
      draftLog.push({ op: "write", seq: payload && payload.seq, editSeq: payload && payload.editSeq,
                      originKind: payload && payload.originKind, hasBase: !!(payload && payload.baseJson) });
      if (draftFailNext && draftFailNext.count > 0) {
        draftFailNext.count--;
        return draftFail(draftFailNext.code);
      }
      if (!payload || typeof payload.stateJson !== "string" || typeof payload.seq !== "number") return draftFail("BAD_PAYLOAD");
      if (!(payload.seq > draftStore.floor)) return draftFail("STALE_SEQ");
      if (payload.baseJson == null && draftStore.base == null) return draftFail("NEED_BASE");
      if (payload.baseJson != null) draftStore.base = payload.baseJson;
      draftStore.previous = draftStore.current;
      draftStore.current = { header: payload, stateJson: payload.stateJson };
      draftStore.floor = payload.seq;
      draftStore.writes++;
      return Promise.resolve({ ok: true, seq: payload.seq, bytes: payload.stateJson.length });
    },
    discardDraft: function (seq) {
      draftLog.push({ op: "discard", seq: seq });
      if (typeof seq === "number") {
        if (seq < draftStore.floor) return Promise.resolve({ ok: false, code: "STALE_SEQ" });
        draftStore.floor = seq;
      }
      draftStore.current = null;
      draftStore.previous = null;
      draftStore.base = null;
      return Promise.resolve({ ok: true });
    },
    takeDraft: function () {
      draftLog.push({ op: "take" });
      return Promise.resolve(draftTaken);
    },
    draftRestoreDone: function (outcome) { draftLog.push({ op: "restore-done", outcome: outcome }); },
    onDraftFlush: function (cb) { flushHandler = cb; },

    _drafts: draftStore,
    _draftLog: draftLog,
    _setDraft: function (taken) { draftTaken = taken; },
    _failNextDraftWrites: function (code, count) {
      draftFailNext = code ? { code: code, count: count == null ? 1 : count } : null;
    },
    _fireDraftFlush: function () { return flushHandler ? flushHandler() : null; },
    _addFile: function (name, text) {
      var id = newId();
      files[id] = { name: name, bytes: strBytes(text), lastModified: Date.now() + nextId };
      return id;
    },
    _text: function (id) { return new TextDecoder().decode(files[id].bytes); },
    _touch: function (id) { if (files[id]) files[id].lastModified = Date.now() + (nextId++); },
    _setBytesKeepMtime: function (id, text) { if (files[id]) files[id].bytes = strBytes(text); },
    _fireOpenFile: function (id) {
      var f = files[id];
      if (openHandler && f) openHandler({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
    },
    _fireMenuCommand: function (cmd) { if (menuHandler) menuHandler(cmd); },
    _fireRestoreNotice: function (notice) { if (restoreNoticeHandler) restoreNoticeHandler(notice); },
    _fireReassignDocId: function (msg) { if (reassignDocIdHandler) reassignDocIdHandler(msg); }
  };
  if (opts && opts.history) addFakeDesktopHistory(backend);
  if (opts && opts.blobs) addFakeDesktopBlobs(backend, opts);
  if (opts && opts.voice) addFakeDesktopVoice(backend);
  return backend;
}

function addFakeDesktopVoice(backend) {
  var handler = null;
  backend._voiceCalls = { status: 0, start: 0, stop: 0 };
  backend._voiceAvailable = true;
  backend._voiceSession = 0;
  backend._voiceRunning = false;
  backend.voiceStatus = function () {
    backend._voiceCalls.status++;
    return Promise.resolve({ available: backend._voiceAvailable });
  };
  backend.voiceStart = function () {
    backend._voiceCalls.start++;
    if (backend._voiceStartAnswer) return Promise.resolve(backend._voiceStartAnswer);
    backend._voiceSession++;
    backend._voiceRunning = true;
    return Promise.resolve({ ok: true, session: backend._voiceSession });
  };
  backend.voiceStop = function () {
    backend._voiceCalls.stop++;
    backend._voiceRunning = false;
    return Promise.resolve({ ok: true });
  };
  backend.onVoiceEvent = function (cb) { handler = cb; };
  backend._voiceEmit = function (event) {
    var e = Object.assign({ session: backend._voiceSession }, event);
    if (handler) handler(e);
  };
}

function addFakeDesktopBlobs(backend, opts) {
  var SHA_RE = /^[0-9a-f]{64}$/;
  var MAX = 16 * 1024 * 1024;
  var hash = typeof opts.blobHash === "function" ? opts.blobHash : null;
  var store = {};
  var calls = [];
  function sniff(u) {
    if (u.length >= 8 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return "image/png";
    if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return "image/jpeg";
    if (u.length >= 6 && u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x38) return "image/gif";
    if (u.length >= 12 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46 &&
        u[8] === 0x57 && u[9] === 0x45 && u[10] === 0x42 && u[11] === 0x50) return "image/webp";
    return null;
  }
  function badSha() { return Promise.reject(new Error("splitpage:blob: argument 1 is not sha256")); }
  backend.blobPut = function (sha, bytes) {
    calls.push({ op: "put", sha: sha });
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return badSha();
    if (typeof bytes === "string") return Promise.resolve({ ok: false, code: "BAD_BYTES" });
    var u = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
    if (!u) return Promise.reject(new Error("splitpage:blob-put: argument 2 is not bytes"));
    if (!u.length) return Promise.resolve({ ok: false, code: "EMPTY" });
    if (u.length > MAX) return Promise.resolve({ ok: false, code: "TOO_LARGE" });
    var mime = sniff(u);
    if (!mime) return Promise.resolve({ ok: false, code: "NOT_AN_IMAGE" });
    if (backend._blobFailNext) { var f = backend._blobFailNext; backend._blobFailNext = null; return Promise.resolve({ ok: false, code: f.code }); }
    if (hash && hash(u) !== sha) return Promise.resolve({ ok: false, code: "HASH_MISMATCH" });
    if (store[sha]) return Promise.resolve({ ok: true, stored: false });
    store[sha] = { bytes: new Uint8Array(u), mime: mime };
    return Promise.resolve({ ok: true, stored: true });
  };
  backend.blobGet = function (sha) {
    calls.push({ op: "get", sha: sha });
    if (typeof sha !== "string" || !SHA_RE.test(sha)) return badSha();
    var e = store[sha];
    return Promise.resolve(e ? { bytes: new Uint8Array(e.bytes), mime: e.mime } : null);
  };
  backend.blobMissing = function (shas) {
    calls.push({ op: "missing", count: Array.isArray(shas) ? shas.length : -1 });
    if (!Array.isArray(shas)) return Promise.reject(new Error("splitpage:blob-missing: argument 1 is not array"));
    if (shas.length > 2000) return Promise.reject(new Error("blob-missing: at most 2000 shas per call"));
    if (!shas.every(function (x) { return typeof x === "string" && SHA_RE.test(x); })) {
      return Promise.reject(new Error("blob-missing: every entry must be a sha256"));
    }
    var seen = {};
    return Promise.resolve(shas.filter(function (x) {
      if (seen[x] || store[x]) return false;
      seen[x] = true;
      return true;
    }));
  };
  backend._blobs = store;
  backend._blobCalls = calls;
  backend._blobFailNext = null;
}

function addFakeDesktopHistory(backend) {
  var mem = createMemoryHistoryBackend({ name: "desktop-fake", persistent: true });
  var held = [];
  var store = createHistoryStore({
    backend: mem,
    now: Date.now,
    hashText: historyHashText,
    holds: function () { return held; }
  });

  function bucketOf(query) {
    if (query && query.older === true) return HISTORY_OLDER_KEY;
    return normalizeDocId(query && query.docId) || null;
  }
  function invalid(what) { return Promise.reject(new Error("history: " + what)); }

  backend.historyPut = function (docId, meta, stateJson, opts) {
    var o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
    var older = o.older === true;
    var id = older ? (docId === null ? HISTORY_OLDER_KEY : null) : normalizeDocId(docId);
    var m = sanitizeHistoryMeta(meta);
    if (!id || !m || typeof stateJson !== "string") return invalid("invalid put");
    if (Array.isArray(o.protect)) held = o.protect.slice();
    return (older ? store.put(null, m, stateJson, { older: true }) : store.put(id, m, stateJson)).then(function (r) {
      if (!r.stored) return { ok: false, code: r.code };
      return { ok: true, sizeBytes: historyUtf8Length(stateJson), duplicate: !!r.duplicate, evicted: r.evicted || 0, overCap: !!r.overCap };
    });
  };

  backend.historyList = function (docId) {
    var id = docId == null ? null : normalizeDocId(docId);
    if (docId != null && !id) return invalid("invalid document id");
    return store.list(id).then(function (r) {
      return store.usage().then(null, function () { return null; }).then(function (usage) {
        return { entries: r.entries.map(sanitizeHistoryMeta), older: r.older.map(sanitizeHistoryMeta), olderExpiresAt: r.olderExpiresAt, usage: usage };
      });
    });
  };

  backend.historyGet = function (query, snapshotId) {
    var bucket = bucketOf(query);
    if (!bucket) return invalid("invalid document id");
    if (typeof snapshotId !== "string" || !HISTORY_SNAP_ID_RE.test(snapshotId)) return invalid("invalid snapshot id");
    if (query && Array.isArray(query.protect)) held = query.protect.slice();
    return store.get(bucket, snapshotId).then(function (hit) {
      return hit ? { meta: sanitizeHistoryMeta(hit.meta), stateJson: hit.stateJson } : null;
    });
  };

  backend.historyCopy = function (fromDocId, toDocId) {
    var from = normalizeDocId(fromDocId), to = normalizeDocId(toDocId);
    if (!from || !to) return invalid("invalid document id");
    return store.copy(from, to);
  };

  backend.historyTouch = function (docId, title) {
    var id = normalizeDocId(docId);
    if (!id) return invalid("invalid document id");
    return store.touch(id, title);
  };

  backend.historyListDocs = function () { return store.listDocs(); };

  backend._historyDump = function () {
    var raw = mem.inspect(), out = {};
    Object.keys(raw.index).forEach(function (bucket) {
      out[bucket] = (raw.index[bucket].snapshots || []).map(function (s) {
        return { meta: sanitizeHistoryMeta(s), stateJson: raw.bodies[s.sha] };
      });
    });
    return out;
  };
  backend._historyStore = store;
  backend._historyBackend = mem;
}
