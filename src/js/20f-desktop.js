import { currentDocument, noteSessionEdit } from "../legacy/session-bridge.ts";
import { checkServer, currentConn, currentHome, fileHome, homeConn, serverHomeId, serverStatus, setHome } from "../legacy/location-bridge.ts";
import { normalizeServerUrl } from "../../shared/server-links.js";
import { reassignDocId } from "./02b-doc-id.js";
import { cssAttr } from "../features/common/dom.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { pointTabAt } from "./13-hosted.js";
import { openDocument } from "../legacy/transition-bridge.ts";
import { flushDraftNow } from "../legacy/recovery-bridge.ts";
import { saveDoc, unsavedChanges } from "../legacy/save-bridge.ts";
import { escapeHtml } from "../core/document/text-policy.ts";
import { startupReady } from "../legacy/startup-bridge.ts";
import { appActions } from "../legacy/app-actions.ts";
import { canOpenPrompterInBrowser, canOpenPrompterInChromium, desktopPort, restoreDesktop, useDesktopForTest } from "../adapters/desktop/desktop-port.ts";
import { makeDesktopHandle } from "../adapters/desktop/desktop-handle.ts";
import { makeDesktopBlobBackend, wireDesktopBlobs } from "../adapters/desktop/desktop-blobs.js";
import { forgetDesktopVoice } from "../adapters/desktop/desktop-voice.js";
import { makeFakeDesktopBackend } from "../adapters/desktop/fake-desktop.js";
import { runningOnDesktop } from "../application/desktop-presence.ts";
import { runMenuCommand } from "../application/desktop/menu-commands.ts";
import { awaitHandedDocument, handedDocumentSettled, notifyDesktopDocumentState } from "../legacy/desktop-bridge.ts";

function runDesktopMenuCommand(cmd) {
  if (runMenuCommand(cmd)) return;
  var item = document.querySelector('#file-menu [data-file-action="' + cssAttr(cmd) + '"]');
  if (item && !item.disabled) item.click();
}

var prompterBrowserBusy = false;

export function driveOpenShown() {
  return !runningOnDesktop() || typeof desktopPort().driveStatus === "function";
}

export function appDataImportShown() {
  return !!desktopBridge();
}

function desktopBridge() {
  return desktopPort();
}

export function routeServerOpen(id) {
  var bridge = desktopBridge();
  return bridge ? bridge.routeOpen({ kind: "server", serverDocId: id, serverUrl: currentConn().serverUrl, token: currentConn().token, tunnel: currentConn().tunnel }).then(function (result) { return !!result && result.where === "this-tab"; }) : null;
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
    if (!currentDocument()) return prompterBrowserResult(false, "Still loading…");
    var serverId = serverHomeId();
    var hc = homeConn();
    if (serverId && hc && hc.serverUrl) return await copyPrompterLinkForRemoteServer(serverId);
    var fh = fileHome();
    var onDisk = !!(fh && fh.handle && fh.handle._desktopId);
    if (!onDisk && !serverId) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
    if (unsavedChanges()) {
      if (onDisk && fh.format === "html") return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
      await saveDoc();
      if (unsavedChanges()) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.SAVE_FAILED);
    }
    var answer;
    try { answer = await (chromium ? desktopPort().openPrompterInChromium() : desktopPort().openPrompterInBrowser()); }
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

export async function renderDesktopShareInfo() {
  var el = document.getElementById("desktop-share-info");
  if (!el || !runningOnDesktop()) return;
  var info;
  try { info = await desktopPort().getSessionInfo(); } catch (e) { info = null; }
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
  if (!runningOnDesktop() || typeof desktopPort().onReassignDocId !== "function") return;
  desktopPort().onReassignDocId(function (msg) {
    if (!msg) return;
    if (reassignDocId(msg.toId, msg)) notifyDesktopDocumentState();
  });
}

export function initDesktop() {
  if (!runningOnDesktop()) return;

  wireDesktopBlobs(desktopPort());

  var driveItem = document.getElementById("menu-drive-open");
  if (driveItem) driveItem.hidden = !driveOpenShown();

  var exportAppItem = document.getElementById("menu-export-app-data");
  if (exportAppItem) exportAppItem.hidden = false;
  var importAppItem = document.getElementById("menu-import-app-data");
  if (importAppItem) importAppItem.hidden = !appDataImportShown();

  var intent = desktopPort().launchIntent && desktopPort().launchIntent.type;
  awaitHandedDocument(intent);

  desktopPort().onOpenFile(function (entry) {
    function proceed() {
      var handle = makeDesktopHandle(entry);
      handle.getFile().then(function (file) {
        return openDocument({ kind: "file", file: file, handle: handle });
      }).catch(function () {
        showToast("Could not open " + ((entry && entry.name) || "that file") + ".", "error");
      }).then(handedDocumentSettled);
    }
    var ready = currentDocument() ? null : startupReady();
    if (ready) ready.then(proceed);
    else proceed();
  });

  desktopPort().onOpenServerDoc(function (payload) {
    var serverDocId = payload && payload.serverDocId;
    if (!serverDocId) return;
    function proceed() {
      adoptPayloadServer(payload);
      openPendingServerDocForTab(serverDocId);
    }
    var ready = currentDocument() ? null : startupReady();
    if (ready) ready.then(proceed);
    else proceed();
  });

  desktopPort().onRestoreNotice(function (notice) {
    var skipped = (notice && notice.skipped) || [];
    if (!skipped.length) return;
    var reasonWord = { missing: "missing", unreadable: "unreadable", "server-unreachable": "server unreachable" };
    var lines = skipped.map(function (s) {
      return (s.name || "a document") + " (" + (reasonWord[s.reason] || s.reason || "unknown") + ")";
    });
    showToast("Could not restore: " + lines.join(", ") + ".", "warn", true);
  });

  wireReassignDocId();

  desktopPort().onMenuCommand(runDesktopMenuCommand);

  if (typeof desktopPort().onDraftFlush === "function") desktopPort().onDraftFlush(flushDraftNow);

  notifyDesktopDocumentState();

  desktopPort().getSessionInfo().then(function (info) {
    if (info && info.hosting) appActions.invoke("show-servers-dialog", "button");
  }).catch(function () {});
}

function adoptPayloadServer(payload) {
  if (typeof payload.serverUrl !== "string") return;
  var url = normalizeServerUrl(payload.serverUrl);
  if (url === currentConn().serverUrl) return;
  if (currentHome().kind === "server") setHome("none");
  serverStatus().forgetMode();
  try {
    pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "", tunnel: payload.tunnel || null });
  } catch (e) {
    pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "" });
  }
  checkServer();
}

function openPendingServerDocForTab(serverDocId) {
  var CHECK_TIMEOUT_MS = 15000;
  var AUTH_TIMEOUT_MS = 10 * 60 * 1000;
  var POLL_MS = 500;
  var checkStart = Date.now();

  function isChecked() { return serverStatus().mode().checked; }
  function needsAuth() {
    return serverStatus().mode().authRequired && !currentConn().token;
  }
  var retried = false;
  function openIt() {
    openDocument({ kind: "server", id: serverDocId }).then(function (ok) {
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

export function __init() {
  if (runningOnDesktop()) wireDesktopBlobs(desktopPort());
  window.__desktopTest = {
    makeHandle: makeDesktopHandle,
    runMenuCommand: runDesktopMenuCommand,
    makeFakeBackend: makeFakeDesktopBackend,
    makeBlobBackend: makeDesktopBlobBackend,
    initDesktop: initDesktop,
    setBackend: function (fake) {
      useDesktopForTest(fake);
      forgetDesktopVoice();
      if (fake && typeof fake.blobPut === "function") wireDesktopBlobs(fake);
      wireReassignDocId();
    },
    restoreBackend: function () {
      restoreDesktop();
      forgetDesktopVoice();
      wireDesktopBlobs(desktopPort());
    },
    get tabId() { var port = desktopPort(); return port && port.tabId; },
    markDirtyForTest: function () { noteSessionEdit(); }
  };
}
