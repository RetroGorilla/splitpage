"use strict";

const fsp = require("node:fs/promises");
const { checkFileGone, copyKept, holdKeep, runCloseCheck, lastWindowClose, FILE_CHECK_TIMEOUT_MS } = require("./close-keep");
const { createQuitWatchdog } = require("./quit-watchdog.ts");
const { unsavedTitles, unsavedDialogFor, decisionFor } = require("./unsaved-dialog.ts");

function createCloseQuit({
  app, dialog, testMode: TEST_MODE, tabs, windowsById, liveWindows, tabHasFile, tabIsUnsaved, draftsHasDraft,
  requestDraftFlush, draftFlushBudgetMs: DRAFT_FLUSH_BUDGET_MS, draftStore, draftsList,
  draftsDiscardForUserDecision, draftsDiscardClean, consumeTestDialogAnswer, activateTab, focusWindow,
  destroyTabView, startInstallerNow, prompterShare, voiceHelper
}) {
  let quitConfirmed = false;
  let quitKeepingDrafts = false;
  const sessionEndKeep = { holder: "session-end" };
  let sessionWritesFrozen = false;
  let sessionEnding = false;
  const closeConfirmedWindows = new WeakSet();
  let installOnQuit = false;
  let installQuitWatcher = null;
  let installQuitWatchdog = null;

  const TEST_CLOSE_STAT_DELAY_MS = TEST_MODE ? Number(process.env.SPLITPAGE_TEST_CLOSE_STAT_DELAY_MS) || 0 : 0;

  function closeCheckStat(p) {
    if (TEST_CLOSE_STAT_DELAY_MS > 0) return new Promise((r) => setTimeout(r, TEST_CLOSE_STAT_DELAY_MS)).then(() => fsp.stat(p));
    return fsp.stat(p);
  }

  function tabFileGone(tab) {
    if (!tabHasFile(tab)) return Promise.resolve(false);
    return checkFileGone(closeCheckStat, tab.source.absPath, FILE_CHECK_TIMEOUT_MS);
  }

  function keepDraftsOfGoneFiles(goneTabs, holder) {
    return Promise.all(goneTabs.map((tab) => {
      holdKeep(tab, holder);
      return requestDraftFlush(tab, DRAFT_FLUSH_BUDGET_MS, true)
        .then((result) => (copyKept(result, draftsHasDraft(tab.id)) ? null : tab));
    })).then((unkept) => unkept.filter(Boolean));
  }

  function goneFileTabsOf(tabIds) {
    const fileTabs = tabIds.map((id) => tabs.get(id)).filter(tabHasFile);
    return Promise.all(fileTabs.map(tabFileGone))
      .then((gone) => fileTabs.filter((tab, i) => gone[i] && tabs.get(tab.id) === tab));
  }

  function askAboutUnsaved(list, verb, parentWin) {
    if (!list.length) return "discard";
    const decision = buildUnsavedDialog(list, verb, parentWin);
    if (decision === "review") reviewFirstUnsaved(list);
    return decision;
  }

  function reportCloseCheckFailure(verb, err) {
    console.error(`[splitpage] close check failed (${verb}): ${(err && err.stack) || err}`);
  }

  function askBeforeClosing(tabIdsNow, verb, parentOf, stillWanted) {
    const io = { tabs, goneFileTabsOf, unsavedTabsOf, askAboutUnsaved, keepDraftsOfGoneFiles, report: reportCloseCheckFailure };
    return runCloseCheck(io, tabIdsNow, verb, parentOf, stillWanted);
  }

  function unsavedTabsOf(tabIds, gone) {
    const out = [];
    for (const id of tabIds) {
      const tab = tabs.get(id);
      if (tabIsUnsaved(tab) || (tab && gone.includes(tab))) out.push(tab);
    }
    return out;
  }

  function allTabsInOrder() {
    const out = [];
    for (const w of windowsById.values()) for (const id of w.tabIds) if (tabs.has(id)) out.push(id);
    return out;
  }

  function buildUnsavedDialog(list, verb, parentWin) {
    if (TEST_MODE) process.stderr.write(`[splitpage] test question (${verb}): ${JSON.stringify(list.map((tab) => tab.id))}\n`);
    const answer = consumeTestDialogAnswer();
    if (answer === "confirm") return "discard";
    if (answer === "cancel") return "cancel";
    if (answer === "review") return "review";
    if (answer === "throw") throw new Error("test: the unsaved-changes question failed");

    const spec = unsavedDialogFor(list.length, verb, list.length === 1 ? [] : unsavedTitles(list, draftsList));
    return decisionFor(spec, dialog.showMessageBoxSync(parentWin, spec.options));
  }

  function reviewFirstUnsaved(list) {
    const first = list[0];
    if (!first || !tabs.has(first.id)) return;
    activateTab(first.id);
    focusWindow(first.windowId);
  }

  function settleDraftsForClose(tabIds, discardUnsaved, reason) {
    const unsaved = [];
    const clean = [];
    for (const id of tabIds) {
      const tab = tabs.get(id);
      if (!tab) continue;
      if (tab.crashedNotReloaded || tab.keepDraftOnClose) continue;
      if (tabIsUnsaved(tab)) unsaved.push(id); else clean.push(id);
    }
    if (discardUnsaved && unsaved.length) draftsDiscardForUserDecision(unsaved, reason);
    for (const id of clean) draftsDiscardClean(id);
  }

  function attachWindowClose(win, rec) {
    win.on("close", (event) => {
      if (quitConfirmed || sessionEnding) {
        closeConfirmedWindows.add(win);
        return;
      }
      if (closeConfirmedWindows.has(win)) return;
      if (rec.closeKeepingDrafts) { event.preventDefault(); return; }

      const tabIds = rec.tabIds.slice();
      const confirmClose = (closing) => {
        const othersOpen = liveWindows().some((w) => w.win !== win);
        const { freezeSession } = lastWindowClose(othersOpen);
        settleDraftsForClose(closing, true, "close-without-saving");
        if (freezeSession) sessionWritesFrozen = true;
        closeConfirmedWindows.add(win);
      };

      if (!tabIds.some((id) => tabHasFile(tabs.get(id)))) {
        if (askAboutUnsaved(unsavedTabsOf(tabIds, []), "Close window", win) !== "discard") { event.preventDefault(); return; }
        confirmClose(tabIds);
        return;
      }

      event.preventDefault();
      rec.closeKeepingDrafts = true;
      const parent = () => (win.isDestroyed() ? undefined : win);
      askBeforeClosing(() => rec.tabIds.slice(), "Close window", parent, () => !quitKeepingDrafts && !quitConfirmed && !sessionEnding).then(({ answer, tabIds: closing }) => {
        rec.closeKeepingDrafts = false;
        if (answer !== "discard" || win.isDestroyed()) return;
        confirmClose(closing);
        win.close();
      });
    });

    win.on("session-end", () => {
      if (sessionEnding) return;
      sessionEnding = true;
      sessionWritesFrozen = true;
      if (draftStore()) { try { draftStore().markSessionEnd(); } catch { } }
      const flushes = [];
      for (const tab of tabs.values()) {
        if (tab.view.webContents.isDestroyed()) continue;
        if (tab.dirty || !tabHasFile(tab)) {
          flushes.push(requestDraftFlush(tab, DRAFT_FLUSH_BUDGET_MS));
          continue;
        }
        flushes.push(tabFileGone(tab).then((gone) => {
          if (gone) holdKeep(tab, sessionEndKeep);
          return requestDraftFlush(tab, DRAFT_FLUSH_BUDGET_MS, gone);
        }));
      }
      Promise.all(flushes).then((results) => {
        if (!TEST_MODE) return;
        const ok = results.filter((r) => r && r.ok).length;
        process.stderr.write(`[splitpage] session-end flush: ${ok}/${results.length} tabs answered\n`);
      });
    });
  }

  function requestCloseTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const w = windowsById.get(tab.windowId);
    if (w && w.tabIds.length === 1) {
      if (!w.win.isDestroyed()) w.win.close();
      return;
    }
    if (tab.closeKeepingDraft) return;
    const parent = () => (w && !w.win.isDestroyed() ? w.win : undefined);
    const close = () => {
      settleDraftsForClose([tabId], true, "leave-without-saving");
      destroyTabView(tabId);
    };
    if (!tabHasFile(tab)) {
      if (askAboutUnsaved(unsavedTabsOf([tabId], []), "Close tab", parent()) === "discard") close();
      return;
    }
    tab.closeKeepingDraft = true;
    const windowClosing = () => {
      const home = windowsById.get(tab.windowId);
      return !!(home && home.closeKeepingDrafts);
    };
    askBeforeClosing(() => [tabId], "Close tab", parent, () => !quitKeepingDrafts && !quitConfirmed && !sessionEnding && !windowClosing()).then(({ answer }) => {
      tab.closeKeepingDraft = false;
      if (answer === "discard" && tabs.get(tabId) === tab) close();
    });
  }

  function quitToInstall(onCancelled) {
    installOnQuit = true;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      installQuitWatcher = done;
      app.quit();
      if (installQuitWatchdog) installQuitWatchdog.stop();
      installQuitWatchdog = createQuitWatchdog(3000, () => quitKeepingDrafts, () => {
        installQuitWatchdog = null;
        if (settled) return;
        installOnQuit = false;
        installQuitWatcher = null;
        onCancelled();
        done({ ok: false, error: "quit-cancelled" });
      });
    });
  }

  function registerQuitHandlers() {
    app.on("before-quit", (event) => {
      if (sessionEnding) return;
      if (quitConfirmed) return;
      if (quitKeepingDrafts) { event.preventDefault(); return; }

      const tabIds = allTabsInOrder();
      const parentOf = (list) => {
        const w = list.length ? windowsById.get(list[0].windowId) : null;
        return w && !w.win.isDestroyed() ? w.win : undefined;
      };
      const stayOpen = () => {
        quitConfirmed = false;
        sessionWritesFrozen = false;
      };
      const confirmQuit = (quitting) => {
        settleDraftsForClose(quitting, true, "quit-without-saving");
        quitConfirmed = true;
        sessionWritesFrozen = true;
      };

      if (!tabIds.some((id) => tabHasFile(tabs.get(id)))) {
        const unsaved = unsavedTabsOf(tabIds, []);
        if (askAboutUnsaved(unsaved, "Quit", parentOf(unsaved)) !== "discard") {
          stayOpen();
          event.preventDefault();
          return;
        }
        confirmQuit(tabIds);
        return;
      }

      event.preventDefault();
      quitKeepingDrafts = true;
      askBeforeClosing(allTabsInOrder, "Quit", parentOf, () => !sessionEnding).then(({ answer, tabIds: quitting }) => {
        quitKeepingDrafts = false;
        if (installQuitWatchdog) installQuitWatchdog.restart();
        if (sessionEnding) return;
        if (answer !== "discard") { stayOpen(); return; }
        confirmQuit(quitting);
        app.quit();
      });
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });

    app.on("will-quit", () => {
      if (installOnQuit) {
        installOnQuit = false;
        const started = startInstallerNow();
        if (installQuitWatchdog) { installQuitWatchdog.stop(); installQuitWatchdog = null; }
        if (installQuitWatcher) {
          installQuitWatcher(started.ok ? { ok: true, quitting: true } : started);
          installQuitWatcher = null;
        }
      }
      if (prompterShare()) prompterShare().closeAll();
      if (voiceHelper()) voiceHelper().stopAll();
      if (draftStore()) { try { draftStore().markCleanExit(); } catch { } }
    });
  }

  return {
    isQuitConfirmed: () => quitConfirmed,
    isSessionEnding: () => sessionEnding,
    sessionWritesAreFrozen: () => sessionWritesFrozen,
    closeConfirmedWindows,
    attachWindowClose,
    requestCloseTab,
    quitToInstall,
    registerQuitHandlers
  };
}

module.exports = { createCloseQuit };
