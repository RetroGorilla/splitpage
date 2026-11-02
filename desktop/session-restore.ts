"use strict";

import type * as NodePath from "node:path";
import type * as NodeFs from "node:fs";
import type { DesktopSessionRestoreDependencies } from "./ipc-boundaries.d.ts";
import type { DesktopMainTab } from "./main-types.d.ts";
import type { createDraftStore } from "./drafts.ts";
import type { pathKey as FilePathKey } from "./file-service.ts";

const path: typeof NodePath = require("node:path");
const fs: typeof NodeFs = require("node:fs");
const { pathKey }: { pathKey: typeof FilePathKey } = require("./file-service.ts");

function createSessionRestore({
  app, BrowserWindow, desktopState, draftStore, draftsList, tabs, windowsById, pathToTabId, claimRoutingKey,
  createTabWindow, createTab, activateTab, liveWindows, firstWindowRecord, payloadForSource, routeLaunchFile,
  argvFilesToOpen, restoreNotice, persistShellState
}: DesktopSessionRestoreDependencies) {
  let hadPriorSession = false;
  let sessionRestoreInProgress = false;

  function draftSourceFromListing(listing: ReturnType<typeof draftsList>[number]): DesktopMainTab["source"] {
    if (listing.filePath) return { kind: "file", absPath: listing.filePath };
    return { kind: "blank" };
  }

  function indexDraftPath(tabId: string, filePath: unknown) {
    if (typeof filePath !== "string" || !filePath || !path.isAbsolute(filePath)) return;
    claimRoutingKey(pathToTabId, pathKey(filePath), tabId);
  }

  function restoreSessionAtLaunch(draftInit?: Pick<ReturnType<ReturnType<typeof createDraftStore>["init"]>, "drafts"> | null) {
    const persisted = desktopState.read();
    const drafts = (draftInit && Array.isArray(draftInit.drafts) ? draftInit.drafts : draftsList())
      .filter((d) => d && d.status !== "unsupported");
    const draftByTab = new Map(drafts.map((d) => [d.tabId, d]));
    hadPriorSession = persisted.windows.some((w) => w.tabs.some((t) => t.source.kind !== "blank"))
      || drafts.length > 0;

    const skipped: Parameters<typeof restoreNotice.set>[1] = [];
    const placed = new Set<string>();

    sessionRestoreInProgress = true;
    try {
      const built: { rec: ReturnType<typeof createTabWindow>; pw: typeof persisted.windows[number] }[] = [];
      for (const pw of persisted.windows) {
        const rec = createTabWindow({ windowId: pw.windowId, bounds: pw.bounds, maximized: pw.maximized });
        built.push({ rec, pw });
      }

      for (const { rec, pw } of built) {
        for (const pt of pw.tabs) {
          const listing = draftByTab.get(pt.tabId);

          if (listing) {
            const source = pt.source.kind === "blank" ? draftSourceFromListing(listing) : pt.source;
            const tab = createTab(rec.id, {
              tabId: pt.tabId,
              source,
              launchIntent: { type: "restore-draft" },
              pendingPayload: payloadForSource(source)
            });
            if (!tab) continue;
            if (draftStore()) { try { (draftStore() as NonNullable<ReturnType<typeof draftStore>>).hold(tab.id); } catch { } }
            indexDraftPath(tab.id, listing.filePath);
            placed.add(tab.id);
            continue;
          }

          if (pt.source.kind === "file") {
            let exists = false;
            try { exists = fs.statSync(pt.source.absPath).isFile(); } catch { exists = false; }
            if (!exists) {
              skipped.push({ name: path.basename(pt.source.absPath), reason: "missing" });
              continue;
            }
            const tab = createTab(rec.id, {
              tabId: pt.tabId,
              source: pt.source,
              launchIntent: { type: "open-file" },
              pendingPayload: { kind: "open-file", absPath: pt.source.absPath }
            });
            if (tab) placed.add(tab.id);
            continue;
          }

        }
      }

      for (const listing of drafts) {
        if (placed.has(listing.tabId) || tabs.has(listing.tabId)) continue;
        const key = listing.placement && listing.placement.windowKey;
        const target = (typeof key === "string" && windowsById.get(key)) || firstWindowRecord();
        if (!target) continue;
        const index = listing.placement && Number.isInteger(listing.placement.index)
          ? listing.placement.index : undefined;
        const orphanSource = draftSourceFromListing(listing);
        const tab = createTab(target.id, {
          tabId: listing.tabId,
          source: orphanSource,
          launchIntent: { type: "restore-draft" },
          pendingPayload: payloadForSource(orphanSource),
          index
        });
        if (!tab) continue;
        if (draftStore()) { try { (draftStore() as NonNullable<ReturnType<typeof draftStore>>).hold(tab.id); } catch { } }
        indexDraftPath(tab.id, listing.filePath);
        placed.add(tab.id);
      }

      if (!windowsById.size) createTabWindow({});
      const blankIdFor = new Map<string, string>();
      for (const { rec, pw } of built) {
        const keep = pw.tabs.find((t) => t.tabId === pw.activeTabId && t.source.kind === "blank")
          || pw.tabs.find((t) => t.source.kind === "blank");
        if (keep && !tabs.has(keep.tabId)) blankIdFor.set(rec.id, keep.tabId);
      }
      for (const rec of liveWindows()) {
        if (rec.tabIds.length) continue;
        createTab(rec.id, {
          tabId: blankIdFor.get(rec.id),
          source: { kind: "blank" },
          launchIntent: { type: "blank" }
        });
      }

      for (const { rec, pw } of built) {
        if (!windowsById.has(rec.id) || !rec.tabIds.length) continue;
        activateTab(rec.tabIds.includes(pw.activeTabId) ? pw.activeTabId : rec.tabIds[0]);
      }
    } finally {
      sessionRestoreInProgress = false;
    }

    for (const f of argvFilesToOpen) routeLaunchFile(f);

    if (skipped.length) {
      const first = firstWindowRecord();
      if (first && first.activeTabId) restoreNotice.set(first.activeTabId, skipped);
    }

    persistShellState();
  }

  function registerActivate() {
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const fresh = createTabWindow({});
        createTab(fresh.id, { source: { kind: "blank" }, launchIntent: { type: "blank" } });
      }
    });
  }

  return {
    hadPriorSession: () => hadPriorSession,
    isRestoringSession: () => sessionRestoreInProgress,
    restoreSessionAtLaunch,
    registerActivate
  };
}

export type { createSessionRestore };

module.exports = { createSessionRestore };
