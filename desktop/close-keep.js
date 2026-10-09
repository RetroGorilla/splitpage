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

module.exports = { checkFileGone, copyKept, holdKeep, releaseKeep, FILE_CHECK_TIMEOUT_MS };
