import type { DesktopPorts } from "./ports.ts";
import type { DesktopShell } from "../../application/desktop/shell.ts";
import { cssAttr } from "../common/dom.ts";

let ports: DesktopPorts | null = null;

function runDesktopMenuCommand(cmd: string) {
  if ((ports as DesktopPorts).menuCommands.run(cmd)) return;
  const item = document.querySelector<HTMLButtonElement>('#file-menu [data-file-action="' + cssAttr(cmd) + '"]');
  if (item && !item.disabled) item.click();
}

let prompterBrowserBusy = false;

function appDataImportShown() {
  return !!desktopBridge();
}

function desktopBridge() {
  return (ports as DesktopPorts).shell();
}

const PROMPTER_BROWSER_MESSAGES = {
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

function prompterBrowserResult(ok: boolean, message: string, kind?: Parameters<DesktopPorts["notices"]["show"]>[1]) {
  (ports as DesktopPorts).notices.show(message, kind || (ok ? "ok" : "warn"), !ok);
  return { ok: ok, message: message };
}

function openPrompterInBrowser() {
  return openPrompterElsewhere(false);
}

function openPrompterInChromium() {
  return openPrompterElsewhere(true);
}

async function openPrompterElsewhere(chromium: boolean) {
  if (!(chromium ? (ports as DesktopPorts).canOpenPrompter.chromium() : (ports as DesktopPorts).canOpenPrompter.browser())) return { ok: false, message: "" };
  if (prompterBrowserBusy) return { ok: false, message: "" };
  prompterBrowserBusy = true;
  try {
    if (!(ports as DesktopPorts).document.current()) return prompterBrowserResult(false, "Still loading…");
    const fh = (ports as DesktopPorts).place.fileHome();
    const onDisk = !!(fh && fh.handle && (fh.handle as Pick<NonNullable<ReturnType<DesktopPorts["place"]["fileHome"]>>, "_desktopId">)._desktopId);
    if (!onDisk) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
    if ((ports as DesktopPorts).saves.unsaved()) {
      if (onDisk && (fh as NonNullable<typeof fh>).format === "html") return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.NOT_SAVED);
      await (ports as DesktopPorts).saves.save();
      if ((ports as DesktopPorts).saves.unsaved()) return prompterBrowserResult(false, PROMPTER_BROWSER_MESSAGES.SAVE_FAILED);
    }
    let answer;
    try { answer = await (chromium ? ((ports as DesktopPorts).shell() as DesktopShell).openPrompterInChromium() : ((ports as DesktopPorts).shell() as DesktopShell).openPrompterInBrowser()); }
    catch (e) { answer = { ok: false, code: "OPEN_FAILED" }; }
    if (answer && answer.ok && chromium) {
      const browserName = typeof answer.browser === "string" && answer.browser ? answer.browser : "a Chromium browser";
      return prompterBrowserResult(true, "Opened in " + browserName +
        ". Follow My Voice there uses the browser's own speech recognition — this window stays open for editing.");
    }
    if (answer && answer.ok) {
      return prompterBrowserResult(true, answer.voice === "relay"
        ? "Opened in your browser. Follow My Voice there listens through this app — this window stays open for editing."
        : "Opened in your browser. Follow My Voice needs Chrome or Edge — this window stays open for editing.");
    }
    const code = answer && answer.code;
    return prompterBrowserResult(false, (PROMPTER_BROWSER_MESSAGES as Record<string, string>)[code as string] || PROMPTER_BROWSER_MESSAGES.OPEN_FAILED);
  } finally {
    prompterBrowserBusy = false;
  }
}

function wireReassignDocId() {
  if (!(ports as DesktopPorts).running() || typeof ((ports as DesktopPorts).shell() as DesktopShell).onReassignDocId !== "function") return;
  (((ports as DesktopPorts).shell() as DesktopShell).onReassignDocId as NonNullable<DesktopShell["onReassignDocId"]>)(function (msg) {
    if (!ports || !msg) return;
    if ((ports as DesktopPorts).reassignDocId(msg.toId, msg)) (ports as DesktopPorts).documentState.notify();
  });
}

function initDesktop() {
  if (!(ports as DesktopPorts).running()) return;

  (ports as DesktopPorts).wireBlobs();

  const exportAppItem = document.getElementById("menu-export-app-data");
  if (exportAppItem) exportAppItem.hidden = false;
  const importAppItem = document.getElementById("menu-import-app-data");
  if (importAppItem) importAppItem.hidden = !appDataImportShown();

  const intent = ((ports as DesktopPorts).shell() as DesktopShell).launchIntent && (((ports as DesktopPorts).shell() as DesktopShell).launchIntent as NonNullable<DesktopShell["launchIntent"]>).type;
  (ports as DesktopPorts).documentState.awaitHanded(intent);

  ((ports as DesktopPorts).shell() as DesktopShell).onOpenFile(function (entry) {
    if (!ports) return;
    const mine = ports;
    function proceed() {
      const handle = mine.makeHandle(entry);
      handle.getFile().then(function (file) {
        return mine.documents.open({ kind: "file", file: file, handle: handle });
      }).catch(function () {
        mine.notices.show("Could not open " + ((entry && entry.name) || "that file") + ".", "error");
      }).then(mine.documentState.settled);
    }
    const ready = (ports as DesktopPorts).document.current() ? null : (ports as DesktopPorts).startup.ready();
    if (ready) ready.then(proceed);
    else proceed();
  });

  ((ports as DesktopPorts).shell() as DesktopShell).onRestoreNotice(function (notice) {
    if (!ports) return;
    const skipped = (notice && notice.skipped) || [];
    if (!skipped.length) return;
    const reasonWord: Record<string, string> = { missing: "missing", unreadable: "unreadable" };
    const lines = skipped.map(function (s) {
      return (s.name || "a document") + " (" + (reasonWord[s.reason as string] || s.reason || "unknown") + ")";
    });
    (ports as DesktopPorts).notices.show("Could not restore: " + lines.join(", ") + ".", "warn", true);
  });

  wireReassignDocId();

  ((ports as DesktopPorts).shell() as DesktopShell).onMenuCommand(function (cmd) {
    if (ports) runDesktopMenuCommand(cmd);
  });

  if (typeof ((ports as DesktopPorts).shell() as DesktopShell).onDraftFlush === "function") (((ports as DesktopPorts).shell() as DesktopShell).onDraftFlush as NonNullable<DesktopShell["onDraftFlush"]>)((ports as DesktopPorts).flushDraft);

  (ports as DesktopPorts).documentState.notify();

}

export function startDesktopView(given: DesktopPorts) {
  ports = given;
  const mounted = ports;
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
