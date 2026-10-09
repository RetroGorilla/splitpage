"use strict";

const FILE_CHECK_TIMEOUT_MS = 1000;

function checkFileGone(stat, absPath, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (gone) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(gone);
    };
    timer = setTimeout(() => finish(true), timeoutMs);
    let pending;
    try { pending = Promise.resolve(stat(absPath)); } catch { finish(true); return; }
    pending.then(
      (s) => finish(!(s && typeof s.isFile === "function" && s.isFile())),
      () => finish(true)
    );
  });
}

function copyKept(result, hasDraft) {
  return !!(result && result.ok === true) && hasDraft === true;
}

function holdKeep(tab, holder) {
  if (!(tab.keepHolders instanceof Set)) tab.keepHolders = new Set();
  tab.keepHolders.add(holder);
  tab.keepDraftOnClose = true;
}

function releaseKeep(tab, holder) {
  if (!(tab.keepHolders instanceof Set)) return;
  tab.keepHolders.delete(holder);
  if (!tab.keepHolders.size) tab.keepDraftOnClose = false;
}

function runCloseCheck(io, tabIdsNow, verb, parentOf, stillWanted) {
  const holder = { verb };
  const held = [];
  const asked = [];
  const round = (ids) => {
    asked.push(...ids);
    return io.goneFileTabsOf(ids).then((gone) => {
      if (!stillWanted()) return "cancel";
      const unsaved = io.unsavedTabsOf(ids.filter((id) => io.tabs.has(id)), gone);
      const first = io.askAboutUnsaved(unsaved, verb, parentOf(unsaved));
      if (first !== "discard" || !gone.length) return first;
      held.push(...gone);
      return io.keepDraftsOfGoneFiles(gone, holder).then((unkept) => {
        if (!stillWanted()) return "cancel";
        const missing = unkept.filter((tab) => io.tabs.get(tab.id) === tab);
        return io.askAboutUnsaved(missing, verb, parentOf(missing));
      });
    }).then((answer) => {
      if (answer !== "discard") return answer;
      const added = tabIdsNow().filter((id) => !asked.includes(id));
      return added.length ? round(added) : answer;
    });
  };
  return Promise.resolve()
    .then(() => round(tabIdsNow()))
    .catch((err) => {
      io.report(verb, err);
      return "cancel";
    })
    .then((answer) => {
      const now = tabIdsNow();
      for (const tab of held) if (answer !== "discard" || !now.includes(tab.id)) releaseKeep(tab, holder);
      return { answer, tabIds: asked.filter((id) => now.includes(id)) };
    });
}

module.exports = { checkFileGone, copyKept, holdKeep, releaseKeep, runCloseCheck, FILE_CHECK_TIMEOUT_MS };
