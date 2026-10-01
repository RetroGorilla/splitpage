import { S } from "./_state.js";
import { conn, fileHome, home, homeConn, serverHomeId, setHome } from "./_home.js";
import { normalizeDocId, reassignDocId } from "./02b-doc-id.js";
import { setBackend as setBlobBackend } from "./02c-blobs.js";
import {
  HISTORY_OLDER_KEY,
  HISTORY_SNAP_ID_RE,
  historyUtf8Length,
  isPristineSeedDocument,
  sanitizeHistoryMeta
} from "./03a-history-store.js";
import { hashText as historyHashText } from "./03c-history-idb.js";
import { createHistoryStore, createMemoryHistoryBackend } from "../../shared/history-store.js";
import { cssAttr } from "./04-richtext.js";
import { markDirty, showToast } from "./12-dirty-toast.js";
import { detectServer, normalizeServerBase, openServerDoc, pointTabAt } from "./13-hosted.js";
import { concatBytes, saveDoc, strBytes } from "./14-export.js";
import { mimeForFilename, openProjectFile } from "./18-local-files.js";
import { openServersDialog } from "./20e-connect.js";
import { draftRestorePending, flushDraftNow } from "./20g-drafts.js";
import { escapeHtml } from "../core/document/text-policy.ts";

export function makeDesktopHandle(entry) {
  var id = entry.id;
  var name = entry.name;
  var handle = {
    kind: "file",
    name: name,
    _desktopId: id,
    getFile: function () {
      return S.DESKTOP.readFile(id).then(function (fresh) {
        name = fresh.name || name;
        handle.name = name;
        var bytes = fresh.bytes instanceof Uint8Array ? fresh.bytes : new Uint8Array(fresh.bytes || []);
        return new File([bytes], name, { lastModified: fresh.lastModified, type: mimeForFilename(name) });
      });
    },
    createWritable: function () {
      var chunks = [];
      return Promise.resolve({
        write: function (chunk) {
          if (typeof chunk === "string") { chunks.push(strBytes(chunk)); return Promise.resolve(); }
          if (chunk instanceof Blob) {
            return chunk.arrayBuffer().then(function (buf) { chunks.push(new Uint8Array(buf)); });
          }
          if (chunk instanceof ArrayBuffer) { chunks.push(new Uint8Array(chunk)); return Promise.resolve(); }
          if (ArrayBuffer.isView(chunk)) {
            chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            return Promise.resolve();
          }
          chunks.push(strBytes(String(chunk)));
          return Promise.resolve();
        },
        close: function () {
          return S.DESKTOP.writeFile(id, concatBytes(chunks)).then(function () {});
        }
      });
    },
    queryPermission: function () { return Promise.resolve("granted"); },
    requestPermission: function () { return Promise.resolve("granted"); },
    isSameEntry: function (other) { return !!other && other._desktopId === id; }
  };
  return handle;
}

var awaitingHandedDocument = false;

export function handedDocumentSettled() {
  if (!awaitingHandedDocument) return;
  awaitingHandedDocument = false;
  notifyDesktopDocumentState();
}

export function notifyDesktopDocumentState() {
  if (!S.DESKTOP || !S.state) return;
  if (awaitingHandedDocument) return;
  var restoring = typeof draftRestorePending !== "undefined" && draftRestorePending;
  var c = homeConn();
  S.DESKTOP.setDocumentState({
    title: S.state.title || "Untitled Script",
    dirty: !!S.dirty || restoring,
    pristine: (typeof isPristineSeedDocument === "function" && isPristineSeedDocument()) && !restoring,
    docId: S.state.docId || null,
    fileId: (home.kind === "file" && home.handle && home.handle._desktopId) || null,
    serverKey: serverHomeId(),
    serverUrl: c ? c.serverUrl : null,
    tunnel: c ? c.tunnel : null,
    role: c ? c.role : null
  });
}

var menuCommandRunner = null;

export function runMenuCommandsWith(runner) {
  menuCommandRunner = runner;
  return function () {
    if (menuCommandRunner === runner) menuCommandRunner = null;
  };
}

function runDesktopMenuCommand(cmd) {
  if (menuCommandRunner && menuCommandRunner(cmd)) return;
  var item = document.querySelector('#file-menu [data-file-action="' + cssAttr(cmd) + '"]');
  if (item && !item.disabled) item.click();
}

var prompterBrowserBusy = false;

export function canOpenPrompterInBrowser() {
  return !!(S.DESKTOP && typeof S.DESKTOP.openPrompterInBrowser === "function");
}

export function canOpenPrompterInChromium() {
  return !!(S.DESKTOP && typeof S.DESKTOP.openPrompterInChromium === "function");
}

export function driveOpenShown() {
  return !S.DESKTOP || typeof S.DESKTOP.driveStatus === "function";
}

export function appDataImportShown() {
  return !!S.DESKTOP;
}

var PROMPTER_BROWSER_MESSAGES = {
  NOT_SAVED: "Save this script first (Ctrl+S), then try again — the browser reads the saved copy.",
  SAVE_FAILED: "The save didn't go through, so the browser would show an older version. Save, then try again.",
  UNSAVED_CHANGES: "The save didn't go through, so the browser would show an older version. Save, then try again.",
  NOT_A_PROJECT: "Only a Splitpage script (.md or .splitpage) can be opened in the browser. Save it as one first.",
  READ_FAILED: "Could not read the saved file — it may have moved. Save it again, then try again.",
  TOO_LARGE: "This script is too large to hand to the browser.",
  NO_SERVER: "The server this script lives on isn't running here any more.",
  REMOTE_SERVER: "This script is on another server — use Share to get its link, then open that in Chrome or Edge.",
  SERVE_FAILED: "Could not open the script in your browser.",
  OPEN_FAILED: "Could not open your browser.",
  NO_TAB: "Could not open the script in your browser.",
  NO_CHROMIUM: "No Chromium browser (Edge, Chrome, Brave…) was found on this computer. Use Present in browser instead."
};

function prompterBrowserResult(ok, message, kind) {
  showToast(message, kind || (ok ? "ok" : "warn"), !ok);
  return { ok: ok, message: message };
}

async function copyPrompterLinkForRemoteServer(id) {
  var link;
  try { link = new URL("?doc=" + encodeURIComponent(id) + "&teleprompter=1", homeConn().serverUrl).href; }
  catch (e) { return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NO_SERVER); }
  var copied;
  try { await navigator.clipboard.writeText(link); copied = true; } catch (e) { copied = false; }
  return prompterBrowserResult(copied, copied
    ? "This script is on another server — link copied. Paste it into Chrome or Edge to read it with Follow My Voice."
    : "This script is on another server. Open this in Chrome or Edge to read it with Follow My Voice: " + link,
    copied ? "ok" : "warn");
}

export function openPrompterInBrowser() {
  return openPrompterElsewhere(false);
}

export function openPrompterInChromium() {
  return openPrompterElsewhere(true);
}

async function openPrompterElsewhere(chromium) {
  if (!(chromium ? canOpenPrompterInChromium() : canOpenPrompterInBrowser())) return { ok: false, message: "" };
  if (prompterBrowserBusy) return { ok: false, message: "" };
  prompterBrowserBusy = true;
  try {
    if (!S.state) return prompterBrowserResult(false, "Still loading…");
    var serverId = serverHomeId();
    var hc = homeConn();
    if (serverId && hc && hc.serverUrl) return await copyPrompterLinkForRemoteServer(serverId);
    var fh = fileHome();
    var onDisk = !!(fh && fh.handle && fh.handle._desktopId);
    if (!onDisk && !serverId) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
    if (S.dirty) {
      if (onDisk && fh.format === "html") return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
      await saveDoc();
      if (S.dirty) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.SAVE_FAILED);
    }
    var answer;
    try { answer = await (chromium ? S.DESKTOP.openPrompterInChromium() : S.DESKTOP.openPrompterInBrowser()); }
    catch (e) { answer = { ok: false, code: "OPEN_FAILED" }; }
    if (answer && answer.ok && chromium) {
      var browserName = typeof answer.browser === "string" && answer.browser ? answer.browser : "a Chromium browser";
      return prompterBrowserResult(true, "Opened in " + browserName +
        ". Follow My Voice there uses the browser's own speech recognition — this window stays open for editing.");
    }
    if (answer && answer.ok) {
      return prompterBrowserResult(true, answer.voice === "relay"
        ? "Opened in your browser. Follow My Voice there listens through this app — this window stays open for editing."
        : "Opened in your browser. Follow My Voice needs Chrome or Edge — this window stays open for editing.");
    }
    var code = answer && answer.code;
    return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES[code] || PROMPTER_BROWSER_MESSAGES.OPEN_FAILED);
  } finally {
    prompterBrowserBusy = false;
  }
}

var desktopVoice = null;
var desktopVoiceAsking = null;
var activeDesktopRecognition = null;
var voiceEventBridge = null;

export function desktopVoiceKnown() {
  return desktopVoice !== null;
}

export function desktopVoiceAvailable() {
  return !!(desktopVoice && desktopVoice.available);
}

export function loadDesktopVoice() {
  if (desktopVoice) return Promise.resolve(desktopVoice);
  if (desktopVoiceAsking) return desktopVoiceAsking;
  var bridge = S.DESKTOP;
  if (!bridge || typeof bridge.voiceStatus !== "function" || typeof bridge.voiceStart !== "function") {
    desktopVoice = { available: false };
    return Promise.resolve(desktopVoice);
  }
  desktopVoiceAsking = Promise.resolve()
    .then(function () { return bridge.voiceStatus(); })
    .then(function (answer) { return { available: !!(answer && answer.available) }; },
          function () { return { available: false }; })
    .then(function (known) {
      desktopVoiceAsking = null;
      if (S.DESKTOP === bridge) desktopVoice = known;
      return known;
    });
  return desktopVoiceAsking;
}

function forgetDesktopVoice() {
  desktopVoice = null;
  desktopVoiceAsking = null;
  activeDesktopRecognition = null;
}

function dispatchVoiceEvent(event) {
  var rec = activeDesktopRecognition;
  if (!rec || !event || typeof event !== "object") return;
  if (rec._session === null) { rec._early.push(event); return; }
  if (event.session === rec._session) rec._handle(event);
}

function wireVoiceEvents(bridge) {
  if (voiceEventBridge === bridge || typeof bridge.onVoiceEvent !== "function") return;
  bridge.onVoiceEvent(dispatchVoiceEvent);
  voiceEventBridge = bridge;
}

var VOICE_START_ERRORS = { UNAVAILABLE: "unavailable", SPAWN_FAILED: "helper-failed", NO_TAB: "helper-failed" };

export function createDesktopRecognition() {
  var bridge = S.DESKTOP;
  wireVoiceEvents(bridge);
  var rec = {
    continuous: true,
    interimResults: true,
    lang: "",
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    onwarning: null,
    ondevice: null,
    _running: false,
    _session: null,
    _early: [],
    _fire: function (name, arg) {
      var fn = rec[name];
      if (typeof fn === "function") fn.call(rec, arg);
    },
    _finish: function () {
      if (!rec._running) return;
      rec._running = false;
      rec._session = null;
      if (activeDesktopRecognition === rec) activeDesktopRecognition = null;
      rec._fire("onend");
    },
    _handle: function (event) {
      if (!rec._running) return;
      if (event.type === "start") {
        rec._fire("onstart");
      } else if (event.type === "device") {
        if (typeof event.name === "string") rec._fire("ondevice", { name: event.name });
      } else if (event.type === "interim" || event.type === "final") {
        if (typeof event.text !== "string") return;
        var result = { isFinal: event.type === "final", length: 1, 0: { transcript: event.text } };
        rec._fire("onresult", { resultIndex: 0, results: [result] });
      } else if (event.type === "warning") {
        rec._fire("onwarning", { warning: event.code });
      } else if (event.type === "error") {
        rec._fire("onerror", { error: event.code });
      } else if (event.type === "end") {
        if (event.reason === "taken") rec._fire("onerror", { error: "taken" });
        rec._finish();
      }
    },
    start: function () {
      if (rec._running) throw new Error("recognition has already started");
      rec._running = true;
      rec._session = null;
      rec._early = [];
      activeDesktopRecognition = rec;
      Promise.resolve()
        .then(function () { return bridge.voiceStart(); })
        .catch(function () { return { ok: false, code: "SPAWN_FAILED" }; })
        .then(function (answer) {
          if (!rec._running || activeDesktopRecognition !== rec) {
            if (answer && answer.ok) bridge.voiceStop();
            return;
          }
          if (!answer || !answer.ok || typeof answer.session !== "number") {
            rec._fire("onerror", { error: VOICE_START_ERRORS[answer && answer.code] || "helper-failed" });
            rec._finish();
            return;
          }
          rec._session = answer.session;
          var early = rec._early;
          rec._early = [];
          early.forEach(function (event) { if (event.session === answer.session) rec._handle(event); });
        });
    },
    stop: function () {
      if (!rec._running) return;
      Promise.resolve().then(function () { return bridge.voiceStop(); }).catch(function () {});
      rec._finish();
    }
  };
  rec.abort = rec.stop;
  return rec;
}

export async function renderDesktopShareInfo() {
  var el = document.getElementById("desktop-share-info");
  if (!el || !S.DESKTOP) return;
  var info;
  try { info = await S.DESKTOP.getSessionInfo(); } catch (e) { info = null; }
  if (!info || !info.hosting) { el.hidden = true; el.innerHTML = ""; return; }
  var lanUrls = info.lanUrls || [];
  var addrs = lanUrls.length
    ? lanUrls.map(function (u) { return '<div class="connect-share-url">' + escapeHtml(u) + "</div>"; }).join("")
    : '<div class="modal-hint">No network address found yet — check this computer is on a network.</div>';
  var pinHtml;
  if (info.pin) {
    pinHtml = '<div class="connect-share-pin">Join PIN:<strong>' + escapeHtml(info.pin) + "</strong></div>" +
      '<p class="modal-hint">This code travels in the clear over plain HTTP — fine on your own ' +
      "network, not on a public one.</p>";
  } else {
    pinHtml = '<p class="modal-hint connect-share-nopin">No PIN — anyone who can reach one of ' +
      "these addresses can open and edit this document.</p>";
  }
  var reviewHtml = "";
  if (info.reviewPin || (info.reviewUrls || []).length) {
    var reviewAddrs = (info.reviewUrls || []).map(function (u) {
      return '<div class="connect-share-url">' + escapeHtml(u) + "</div>";
    }).join("");
    reviewHtml = '<div class="connect-add-title">To read and comment only</div>' +
      '<p class="modal-hint">Send one of these instead — the server refuses every change ' +
      "but a comment, whatever their copy of Splitpage lets them click.</p>" + reviewAddrs +
      (info.reviewPin
        ? '<div class="connect-share-pin">Review PIN:<strong>' + escapeHtml(info.reviewPin) + "</strong></div>"
        : "");
  }
  el.innerHTML = '<div class="connect-add-title">Sharing this session</div>' +
    '<p class="modal-hint">Others on your network can open:</p>' + addrs + pinHtml + reviewHtml +
    '<p class="modal-hint">Closing Splitpage stops sharing.</p>';
  el.hidden = false;
}

function wireReassignDocId() {
  if (!S.DESKTOP || typeof S.DESKTOP.onReassignDocId !== "function") return;
  S.DESKTOP.onReassignDocId(function (msg) {
    if (!msg) return;
    if (reassignDocId(msg.toId, msg)) notifyDesktopDocumentState();
  });
}

export function initDesktop() {
  if (!S.DESKTOP) return;

  wireDesktopBlobs(S.DESKTOP);

  var driveItem = document.getElementById("menu-drive-open");
  if (driveItem) driveItem.hidden = !driveOpenShown();

  var exportAppItem = document.getElementById("menu-export-app-data");
  if (exportAppItem) exportAppItem.hidden = false;
  var importAppItem = document.getElementById("menu-import-app-data");
  if (importAppItem) importAppItem.hidden = !appDataImportShown();

  var intent = S.DESKTOP.launchIntent && S.DESKTOP.launchIntent.type;
  awaitingHandedDocument = intent === "open-file" || intent === "open-server";

  S.DESKTOP.onOpenFile(function (entry) {
    function proceed() {
      var handle = makeDesktopHandle(entry);
      handle.getFile().then(function (file) {
        return openProjectFile(file, handle);
      }).catch(function () {
        showToast("Could not open " + ((entry && entry.name) || "that file") + ".", "error");
      }).then(handedDocumentSettled);
    }
    if (S.state) proceed();
    else if (S.initialStateReady) S.initialStateReady.then(proceed);
    else proceed();
  });

  S.DESKTOP.onOpenServerDoc(function (payload) {
    var serverDocId = payload && payload.serverDocId;
    if (!serverDocId) return;
    function proceed() {
      adoptPayloadServer(payload);
      openPendingServerDocForTab(serverDocId);
    }
    if (S.state) proceed();
    else if (S.initialStateReady) S.initialStateReady.then(proceed);
    else proceed();
  });

  S.DESKTOP.onRestoreNotice(function (notice) {
    var skipped = (notice && notice.skipped) || [];
    if (!skipped.length) return;
    var reasonWord = { missing: "missing", unreadable: "unreadable", "server-unreachable": "server unreachable" };
    var lines = skipped.map(function (s) {
      return (s.name || "a document") + " (" + (reasonWord[s.reason] || s.reason || "unknown") + ")";
    });
    showToast("Could not restore: " + lines.join(", ") + ".", "warn", true);
  });

  wireReassignDocId();

  S.DESKTOP.onMenuCommand(runDesktopMenuCommand);

  if (typeof S.DESKTOP.onDraftFlush === "function") S.DESKTOP.onDraftFlush(flushDraftNow);

  notifyDesktopDocumentState();

  S.DESKTOP.getSessionInfo().then(function (info) {
    if (info && info.hosting && typeof openServersDialog === "function") openServersDialog();
  }).catch(function () {});
}

function adoptPayloadServer(payload) {
  if (typeof payload.serverUrl !== "string") return;
  var url = normalizeServerBase(payload.serverUrl);
  if (url === conn.serverUrl) return;
  if (home.kind === "server") setHome("none");
  S.serverMode = { available: false, readOnly: false, checked: false, authRequired: false,
                   reviewAvailable: false, version: null };
  try {
    pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "", tunnel: payload.tunnel || null });
  } catch (e) {
    pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "" });
  }
  detectServer();
}

function openPendingServerDocForTab(serverDocId) {
  var CHECK_TIMEOUT_MS = 15000;
  var AUTH_TIMEOUT_MS = 10 * 60 * 1000;
  var POLL_MS = 500;
  var checkStart = Date.now();

  function isChecked() { return typeof S.serverMode !== "undefined" && S.serverMode && S.serverMode.checked; }
  function needsAuth() {
    return typeof S.serverMode !== "undefined" && S.serverMode && S.serverMode.authRequired && !conn.token;
  }
  var retried = false;
  function openIt() {
    if (typeof openServerDoc !== "function") { handedDocumentSettled(); return; }
    Promise.resolve(openServerDoc(serverDocId)).then(function (ok) {
      if (ok === false && !retried && needsAuth()) { retried = true; afterDetect(); return; }
      handedDocumentSettled();
    }, handedDocumentSettled);
  }

  (function waitForDetect() {
    if (isChecked() || Date.now() - checkStart > CHECK_TIMEOUT_MS) { afterDetect(); return; }
    setTimeout(waitForDetect, POLL_MS);
  })();

  function afterDetect() {
    if (!needsAuth()) { openIt(); return; }
    var authStart = Date.now();
    (function waitForAuth() {
      if (!needsAuth() || Date.now() - authStart > AUTH_TIMEOUT_MS) { openIt(); return; }
      setTimeout(waitForAuth, POLL_MS);
    })();
  }
}

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

function makeFakeDesktopBackend(opts) {
  var files = {};
  var recents = [];
  var nextId = 1;
  var openHandler = null;
  var menuHandler = null;
  var openServerDocHandler = null;
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
    onOpenServerDoc: function (cb) { openServerDocHandler = cb; },
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
    _fireOpenServerDoc: function (payload) { if (openServerDocHandler) openServerDocHandler(payload); },
    _fireRestoreNotice: function (notice) { if (restoreNoticeHandler) restoreNoticeHandler(notice); },
    _fireReassignDocId: function (msg) { if (reassignDocIdHandler) reassignDocIdHandler(msg); }
  };
  if (opts && opts.history) addFakeDesktopHistory(backend);
  if (opts && opts.drive) addFakeDesktopDrive(backend);
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

function addFakeDesktopDrive(backend) {
  var ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
  var FOLDER = "application/vnd.google-apps.folder";
  var nextFile = 1;
  var drive = {
    configured: true,
    signedIn: false,
    persisted: true,
    email: "writer@example.com",
    signInAnswer: null,
    failNext: null,
    files: {
      root: { id: "root", name: "My Drive", mimeType: FOLDER, parent: null },
      scriptsFolder01: { id: "scriptsFolder01", name: "Scripts", mimeType: FOLDER, parent: "root" },
      pilotFile01: { id: "pilotFile01", name: "Pilot.fountain", mimeType: "text/plain", parent: "scriptsFolder01", text: "INT. KITCHEN - DAY\n" },
      gdoc01: { id: "gdoc01", name: "Notes", mimeType: "application/vnd.google-apps.document", parent: "scriptsFolder01", text: "Notes as text.\n" },
      sheet01: { id: "sheet01", name: "Budget", mimeType: "application/vnd.google-apps.spreadsheet", parent: "scriptsFolder01" }
    }
  };
  var calls = [];
  function status() {
    return {
      ok: true, configured: drive.configured, signedIn: drive.configured && drive.signedIn,
      persisted: drive.signedIn && drive.persisted, canPersist: drive.persisted, signingIn: false,
      email: drive.signedIn ? drive.email : "", name: "",
      clientFilePath: "/fake/userData/google-oauth-client.json",
      envVars: ["SPLITPAGE_GOOGLE_CLIENT_ID", "SPLITPAGE_GOOGLE_CLIENT_SECRET"]
    };
  }
  function entry(f) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, size: f.text != null ? strBytes(f.text).length : null, modifiedTime: "2026-09-01T10:00:00.000Z" };
  }
  function gate() {
    if (drive.failNext) { var f = drive.failNext; drive.failNext = null; if (f.code === "SIGNED_OUT") drive.signedIn = false; return { ok: false, code: f.code }; }
    if (!drive.signedIn) return { ok: false, code: "SIGNED_OUT" };
    return null;
  }
  function bytesOf(v) {
    if (typeof v === "string") return strBytes(v);
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return null;
  }
  backend.driveStatus = function () { calls.push({ op: "status", args: [].slice.call(arguments) }); return Promise.resolve(status()); };
  backend.driveSignIn = function () {
    calls.push({ op: "signIn", args: [].slice.call(arguments) });
    if (!drive.configured) return Promise.resolve({ ok: false, code: "NOT_CONFIGURED" });
    if (drive.signInAnswer) { var a = drive.signInAnswer; drive.signInAnswer = null; return Promise.resolve(a); }
    drive.signedIn = true;
    return Promise.resolve(status());
  };
  backend.driveSignOut = function () {
    calls.push({ op: "signOut", args: [].slice.call(arguments) });
    drive.signedIn = false;
    return Promise.resolve({ ok: true, status: status() });
  };
  backend.driveList = function (folderId) {
    calls.push({ op: "list", args: [].slice.call(arguments) });
    var g = gate(); if (g) return Promise.resolve(g);
    if (typeof folderId !== "string" || !ID_RE.test(folderId)) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var folder = drive.files[folderId];
    if (!folder) return Promise.resolve({ ok: false, code: "NOT_FOUND" });
    if (folder.mimeType !== FOLDER) return Promise.resolve({ ok: false, code: "NOT_A_FOLDER" });
    var kids = Object.keys(drive.files).map(function (k) { return drive.files[k]; })
      .filter(function (f) { return f.parent === folderId; })
      .sort(function (a, b) { return ((b.mimeType === FOLDER) - (a.mimeType === FOLDER)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return Promise.resolve({ ok: true, folder: entry(folder), files: kids.map(entry) });
  };
  backend.driveDownload = function (fileId) {
    calls.push({ op: "download", args: [].slice.call(arguments) });
    var g = gate(); if (g) return Promise.resolve(g);
    if (typeof fileId !== "string" || !ID_RE.test(fileId)) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var f = drive.files[fileId];
    if (!f) return Promise.resolve({ ok: false, code: "NOT_FOUND" });
    if (f.mimeType === FOLDER) return Promise.resolve({ ok: false, code: "IS_A_FOLDER" });
    if (f.text == null) return Promise.resolve({ ok: false, code: "UNSUPPORTED" });
    return Promise.resolve({ ok: true, file: entry(f), bytes: strBytes(f.text) });
  };
  backend.driveUpload = function (req) {
    calls.push({ op: "upload", args: [].slice.call(arguments) });
    var g = gate(); if (g) return Promise.resolve(g);
    var bytes = req && bytesOf(req.bytes);
    if (!req || !bytes) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var text = new TextDecoder().decode(bytes);
    if (req.fileId !== undefined) {
      var f = drive.files[req.fileId];
      if (!f) return Promise.resolve({ ok: false, code: "NOT_FOUND" });
      f.text = text;
      f.revisions = (f.revisions || 1) + 1;
      return Promise.resolve({ ok: true, file: entry(f) });
    }
    if (!ID_RE.test(String(req.parentId)) || typeof req.name !== "string" || !req.name) return Promise.resolve({ ok: false, code: "BAD_ARGS" });
    var id = "upload" + (nextFile++);
    drive.files[id] = { id: id, name: req.name, mimeType: req.mimeType || "application/octet-stream", parent: req.parentId, text: text };
    return Promise.resolve({ ok: true, file: entry(drive.files[id]) });
  };
  backend._drive = drive;
  backend._driveCalls = calls;
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

export function __init() {
  if (S.DESKTOP) wireDesktopBlobs(S.DESKTOP);
  window.__desktopTest = {
    makeHandle: makeDesktopHandle,
    runMenuCommand: runDesktopMenuCommand,
    makeFakeBackend: makeFakeDesktopBackend,
    makeBlobBackend: makeDesktopBlobBackend,
    initDesktop: initDesktop,
    setBackend: function (fake) {
      S.DESKTOP = fake;
      forgetDesktopVoice();
      if (fake && typeof fake.blobPut === "function") wireDesktopBlobs(fake);
      wireReassignDocId();
    },
    restoreBackend: function () {
      S.DESKTOP = window.splitpageDesktop || null;
      forgetDesktopVoice();
      wireDesktopBlobs(S.DESKTOP);
    },
    get tabId() { return S.DESKTOP && S.DESKTOP.tabId; },
    markDirtyForTest: function () { markDirty(); }
  };
}
