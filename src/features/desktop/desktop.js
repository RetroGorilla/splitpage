import { normalizeServerUrl } from "../../../shared/server-links.js";
import { cssAttr } from "../common/dom.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";

var ports = null;

function runDesktopMenuCommand(cmd) {
  if (ports.menuCommands.run(cmd)) return;
  var item = document.querySelector('#file-menu [data-file-action="' + cssAttr(cmd) + '"]');
  if (item && !item.disabled) item.click();
}

var prompterBrowserBusy = false;

function appDataImportShown() {
  return !!desktopBridge();
}

function desktopBridge() {
  return ports.shell();
}

function routeServerOpen(id) {
  var bridge = desktopBridge();
  return bridge ? bridge.routeOpen({ kind: "server", serverDocId: id, serverUrl: ports.place.connection().serverUrl, token: ports.place.connection().token, tunnel: ports.place.connection().tunnel }).then(function (result) { return !!result && result.where === "this-tab"; }) : null;
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
  ports.notices.show(message, kind || (ok ? "ok" : "warn"), !ok);
  return { ok: ok, message: message };
}

async function copyPrompterLinkForRemoteServer(id) {
  var link;
  try { link = new URL("?doc=" + encodeURIComponent(id) + "&teleprompter=1", ports.place.homeConn().serverUrl).href; }
  catch (e) { return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NO_SERVER); }
  var copied;
  try { await navigator.clipboard.writeText(link); copied = true; } catch (e) { copied = false; }
  return prompterBrowserResult(copied, copied
    ? "This script is on another server — link copied. Paste it into Chrome or Edge to read it with Follow My Voice."
    : "This script is on another server. Open this in Chrome or Edge to read it with Follow My Voice: " + link,
    copied ? "ok" : "warn");
}

function openPrompterInBrowser() {
  return openPrompterElsewhere(false);
}

function openPrompterInChromium() {
  return openPrompterElsewhere(true);
}

async function openPrompterElsewhere(chromium) {
  if (!(chromium ? ports.canOpenPrompter.chromium() : ports.canOpenPrompter.browser())) return { ok: false, message: "" };
  if (prompterBrowserBusy) return { ok: false, message: "" };
  prompterBrowserBusy = true;
  try {
    if (!ports.document.current()) return prompterBrowserResult(false, "Still loading…");
    var serverId = ports.place.serverHomeId();
    var hc = ports.place.homeConn();
    if (serverId && hc && hc.serverUrl) return await copyPrompterLinkForRemoteServer(serverId);
    var fh = ports.place.fileHome();
    var onDisk = !!(fh && fh.handle && fh.handle._desktopId);
    if (!onDisk && !serverId) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
    if (ports.saves.unsaved()) {
      if (onDisk && fh.format === "html") return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
      await ports.saves.save();
      if (ports.saves.unsaved()) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.SAVE_FAILED);
    }
    var answer;
    try { answer = await (chromium ? ports.shell().openPrompterInChromium() : ports.shell().openPrompterInBrowser()); }
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

async function renderDesktopShareInfo() {
  var el = document.getElementById("desktop-share-info");
  if (!el || !ports.running()) return;
  var info;
  try { info = await ports.shell().getSessionInfo(); } catch (e) { info = null; }
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
  if (!ports.running() || typeof ports.shell().onReassignDocId !== "function") return;
  ports.shell().onReassignDocId(function (msg) {
    if (!ports || !msg) return;
    if (ports.reassignDocId(msg.toId, msg)) ports.documentState.notify();
  });
}

function initDesktop() {
  if (!ports.running()) return;

  ports.wireBlobs();

  var driveItem = document.getElementById("menu-drive-open");
  if (driveItem) driveItem.hidden = !ports.driveOpenShown();

  var exportAppItem = document.getElementById("menu-export-app-data");
  if (exportAppItem) exportAppItem.hidden = false;
  var importAppItem = document.getElementById("menu-import-app-data");
  if (importAppItem) importAppItem.hidden = !appDataImportShown();

  var intent = ports.shell().launchIntent && ports.shell().launchIntent.type;
  ports.documentState.awaitHanded(intent);

  ports.shell().onOpenFile(function (entry) {
    if (!ports) return;
    var mine = ports;
    function proceed() {
      var handle = mine.makeHandle(entry);
      handle.getFile().then(function (file) {
        return mine.documents.open({ kind: "file", file: file, handle: handle });
      }).catch(function () {
        mine.notices.show("Could not open " + ((entry && entry.name) || "that file") + ".", "error");
      }).then(mine.documentState.settled);
    }
    var ready = ports.document.current() ? null : ports.startup.ready();
    if (ready) ready.then(proceed);
    else proceed();
  });

  ports.shell().onOpenServerDoc(function (payload) {
    if (!ports) return;
    var serverDocId = payload && payload.serverDocId;
    if (!serverDocId) return;
    function proceed() {
      adoptPayloadServer(payload);
      openPendingServerDocForTab(serverDocId);
    }
    var ready = ports.document.current() ? null : ports.startup.ready();
    if (ready) ready.then(proceed);
    else proceed();
  });

  ports.shell().onRestoreNotice(function (notice) {
    if (!ports) return;
    var skipped = (notice && notice.skipped) || [];
    if (!skipped.length) return;
    var reasonWord = { missing: "missing", unreadable: "unreadable", "server-unreachable": "server unreachable" };
    var lines = skipped.map(function (s) {
      return (s.name || "a document") + " (" + (reasonWord[s.reason] || s.reason || "unknown") + ")";
    });
    ports.notices.show("Could not restore: " + lines.join(", ") + ".", "warn", true);
  });

  wireReassignDocId();

  ports.shell().onMenuCommand(function (cmd) {
    if (ports) runDesktopMenuCommand(cmd);
  });

  if (typeof ports.shell().onDraftFlush === "function") ports.shell().onDraftFlush(ports.flushDraft);

  ports.documentState.notify();

  var actions = ports.actions;
  ports.shell().getSessionInfo().then(function (info) {
    if (info && info.hosting) actions.invoke("show-servers-dialog", "button");
  }).catch(function () {});
}

function adoptPayloadServer(payload) {
  if (typeof payload.serverUrl !== "string") return;
  var url = normalizeServerUrl(payload.serverUrl);
  if (url === ports.place.connection().serverUrl) return;
  if (ports.place.home().kind === "server") ports.server.setHome("none");
  ports.server.forgetMode();
  try {
    ports.server.pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "", tunnel: payload.tunnel || null });
  } catch (e) {
    ports.server.pointTabAt(url, { token: typeof payload.token === "string" ? payload.token : "" });
  }
  ports.server.check();
}

function openPendingServerDocForTab(serverDocId) {
  var CHECK_TIMEOUT_MS = 15000;
  var AUTH_TIMEOUT_MS = 10 * 60 * 1000;
  var POLL_MS = 500;
  var checkStart = Date.now();
  var mine = ports;

  function isChecked() { return mine.place.serverMode().checked; }
  function needsAuth() {
    return mine.place.serverMode().authRequired && !mine.place.connection().token;
  }
  var retried = false;
  function openIt() {
    mine.documents.open({ kind: "server", id: serverDocId }).then(function (ok) {
      if (ok === false && !retried && needsAuth()) { retried = true; afterDetect(); return; }
      mine.documentState.settled();
    }, mine.documentState.settled);
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

export function startDesktopView(given) {
  ports = given;
  var mounted = ports;
  return {
    renderShareInfo: renderDesktopShareInfo,
    openPrompterInBrowser: openPrompterInBrowser,
    openPrompterInChromium: openPrompterInChromium,
    routeServerOpen: routeServerOpen,
    initDesktop: initDesktop,
    runMenuCommand: runDesktopMenuCommand,
    wireReassignDocId: wireReassignDocId,
    dispose: function () {
      if (ports === mounted) ports = null;
    }
  };
}
