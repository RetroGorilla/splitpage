"use strict";

import type { BrowserWindow } from "electron";
import type { DesktopMainCommon } from "./ipc-boundaries.d.ts";
import type { DesktopMainTab } from "./main-types.d.ts";
import type { decisionFor } from "./unsaved-dialog.ts";

export type CloseCheckDecision = ReturnType<typeof decisionFor>;
export interface CloseCheckIo extends Pick<DesktopMainCommon, "tabs"> {
  goneFileTabsOf: (ids: (string | undefined)[]) => Promise<DesktopMainTab[]>;
  unsavedTabsOf: (ids: (string | undefined)[], gone: DesktopMainTab[]) => DesktopMainTab[];
  askAboutUnsaved: (list: DesktopMainTab[], verb: string, parent: BrowserWindow | undefined, gone: DesktopMainTab[]) => CloseCheckDecision;
  keepDraftsOfGoneFiles: (tabs: DesktopMainTab[], holder: object) => Promise<DesktopMainTab[]>;
  report: (verb: string, error: unknown) => void;
}

const FILE_CHECK_TIMEOUT_MS = 1000;

function checkFileGone(stat: (path: unknown) => unknown, absPath: unknown, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (gone: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(gone);
    };
    timer = setTimeout(() => finish(true), timeoutMs);
    let pending;
    try { pending = Promise.resolve(stat(absPath)); } catch { finish(true); return; }
    pending.then(
      (s) => finish(!(s && typeof (s as { isFile?: unknown }).isFile === "function" && (s as { isFile: () => unknown }).isFile())),
      () => finish(true)
    );
  });
}

function copyKept(result: unknown, hasDraft: boolean) {
  return !!(result && (result as { ok?: unknown }).ok === true) && hasDraft === true;
}

function holdKeep(tab: Pick<DesktopMainTab, "keepHolders" | "keepDraftOnClose">, holder: object) {
  if (!(tab.keepHolders instanceof Set)) tab.keepHolders = new Set();
  tab.keepHolders.add(holder);
  tab.keepDraftOnClose = true;
}

function releaseKeep(tab: Pick<DesktopMainTab, "keepHolders" | "keepDraftOnClose">, holder: object) {
  if (!(tab.keepHolders instanceof Set)) return;
  tab.keepHolders.delete(holder);
  if (!tab.keepHolders.size) tab.keepDraftOnClose = false;
}

function runCloseCheck(io: CloseCheckIo, tabIdsNow: () => (string | undefined)[], verb: string, parentOf: (tabs: DesktopMainTab[]) => BrowserWindow | undefined, stillWanted: () => boolean) {
  const holder = { verb };
  const held: DesktopMainTab[] = [];
  const asked: (string | undefined)[] = [];
  const answered = new Set<string | undefined>();
  const ask = async (list: DesktopMainTab[], gone: DesktopMainTab[] = []) => {
    const answer = io.askAboutUnsaved(list, verb, parentOf(list), gone);
    if (answer === "discard") for (const tab of list) answered.add(tab.id);
    // why: A quit question blocks main while other windows can queue edits; drain those before rechecking.
    if (verb === "Quit" && list.length && answer === "discard") await new Promise((resolve) => setTimeout(resolve, 0));
    return answer;
  };
  const round = (ids: (string | undefined)[]): Promise<CloseCheckDecision> => {
    asked.push(...ids);
    return io.goneFileTabsOf(ids).then(async (gone) => {
      if (!stillWanted()) return "cancel";
      const unsaved = io.unsavedTabsOf(ids.filter((id) => io.tabs.has(id)), gone);
      const first = await ask(unsaved, gone);
      if (!stillWanted()) return "cancel";
      if (first !== "discard" || !gone.length) return first;
      held.push(...gone);
      return io.keepDraftsOfGoneFiles(gone, holder).then(async (unkept) => {
        // why: A successful keep reply can also overtake another window's queued edit.
        if (verb === "Quit") await new Promise((resolve) => setTimeout(resolve, 0));
        if (!stillWanted()) return "cancel";
        const missing = unkept.filter((tab) => io.tabs.get(tab.id) === tab);
        return ask(missing, gone);
      });
    }).then(next);
  };
  const next = (answer: CloseCheckDecision): CloseCheckDecision | Promise<CloseCheckDecision> => {
    if (!stillWanted()) return "cancel";
    if (answer !== "discard") return answer;
    const now = tabIdsNow();
    const added = now.filter((id) => !asked.includes(id));
    if (added.length) return round(added);
    const changed = io.unsavedTabsOf(asked.filter((id) => now.includes(id) && !answered.has(id)), []);
    return changed.length ? ask(changed).then(next) : answer;
  };
  return Promise.resolve()
    .then(() => round(tabIdsNow()))
    .catch((err): CloseCheckDecision => {
      io.report(verb, err);
      return "cancel";
    })
    .then((answer) => {
      const now = tabIdsNow();
      for (const tab of held) if (answer !== "discard" || !now.includes(tab.id)) releaseKeep(tab, holder);
      return { answer, tabIds: asked.filter((id) => now.includes(id)) };
    });
}

function lastWindowClose(othersOpen: boolean) {
  return { freezeSession: !othersOpen };
}

export type { checkFileGone, copyKept, holdKeep, releaseKeep, runCloseCheck, lastWindowClose, FILE_CHECK_TIMEOUT_MS };

module.exports = { checkFileGone, copyKept, holdKeep, releaseKeep, runCloseCheck, lastWindowClose, FILE_CHECK_TIMEOUT_MS };
