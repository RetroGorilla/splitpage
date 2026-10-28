import { cssAttr } from "../common/dom.ts";

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

var PROMPTER_BROWSER_MESSAGES = {
  NOT_SAVED: "Save this script first (Ctrl+S), then try again — the browser reads the saved copy.",
  SAVE_FAILED: "The save didn't go through, so the browser would show an older version. Save, then try again.",
  UNSAVED_CHANGES: "The save didn't go through, so the browser would show an older version. Save, then try again.",
  NOT_A_PROJECT: "Only a Splitpage script (.md or .splitpage) can be opened in the browser. Save it as one first.",
  READ_FAILED: "Could not read the saved file — it may have moved. Save it again, then try again.",
  TOO_LARGE: "This script is too large to hand to the browser.",
  SERVE_FAILED: "Could not open the script in your browser.",
  OPEN_FAILED: "Could not open your browser.",
  NO_TAB: "Could not open the script in your browser.",
  NO_CHROMIUM: "No Chromium browser (Edge, Chrome, Brave…) was found on this computer. Use Present in browser instead."
};

function prompterBrowserResult(ok, message, kind) {
  ports.notices.show(message, kind || (ok ? "ok" : "warn"), !ok);
  return { ok: ok, message: message };
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
    var fh = ports.place.fileHome();
    var onDisk = !!(fh && fh.handle && fh.handle._desktopId);
    if (!onDisk) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
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

  ports.shell().onRestoreNotice(function (notice) {
    if (!ports) return;
    var skipped = (notice && notice.skipped) || [];
    if (!skipped.length) return;
    var reasonWord = { missing: "missing", unreadable: "unreadable" };
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

}

export function startDesktopView(given) {
  ports = given;
  var mounted = ports;
  return {
    openPrompterInBrowser: openPrompterInBrowser,
    openPrompterInChromium: openPrompterInChromium,
    initDesktop: initDesktop,
    runMenuCommand: runDesktopMenuCommand,
    wireReassignDocId: wireReassignDocId,
    dispose: function () {
      if (ports === mounted) ports = null;
    }
  };
}
