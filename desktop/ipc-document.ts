"use strict";

import type { DesktopWireFailure } from "../shared/desktop-contract.d.ts";

import type * as NodeFs from "node:fs";

import type { DesktopDraftStoreBoundary, DesktopFileServiceBoundary, DesktopDocumentIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { LAST_KNOWN_TITLE_MAX as DesktopTitleLimit } from "./desktop-state.ts";

const fs: typeof NodeFs = require("node:fs");
const { readFileEntry }: Pick<DesktopFileServiceBoundary, "readFileEntry"> = require("./file-service");
const { restoreDoneAction }: { restoreDoneAction: (outcome: string) => "open" | "drop" | "release" } = require("./drafts");
const { LAST_KNOWN_TITLE_MAX }: { LAST_KNOWN_TITLE_MAX: typeof DesktopTitleLimit } = require("./desktop-state.ts");

function createDocumentIpc({
  tabOf, fileIds, unindexTabSource, indexTabSource, recents, windowsById, applyWindowTitle,
  pushShellState, persistShellState, docClaims, testMode: TEST_MODE, flushPendingPayload, restoreNotice,
  routeOpenPath, draftStore, draftFiniteNumber, draftBodyTooLarge, buildDraftHeader, draftsPreviousSession,
  pendingDraftFlushes
}: DesktopDocumentIpcDependencies) {
  function registerDocumentIpc({ ipcHandle, ipcOn }: Parameters<DesktopRegisterIpcGroup>[0]) {
    ipcOn("splitpage:set-document-state", (event, docState) => {
      const tab = tabOf(event);
      if (!tab) return;
      const s = docState || {};

      tab.title = typeof s.title === "string" && s.title ? s.title.slice(0, LAST_KNOWN_TITLE_MAX) : "Untitled";
      tab.dirty = !!s.dirty;
      if ("pristine" in s) tab.pristine = !!s.pristine;
      if ("docId" in s) tab.docId = typeof s.docId === "string" ? s.docId : null;

      const hasFileId = "fileId" in s;
      const absPath = hasFileId && typeof s.fileId === "string" ? fileIds.pathOf(s.fileId) || null : null;
      if (hasFileId) {
        tab.fileId = absPath ? s.fileId : null;
        unindexTabSource(tab);
        tab.source = absPath ? { kind: "file", absPath } : { kind: "blank" };
        indexTabSource(tab);
      }

      if (tab.source.kind === "file") recents.note(tab.source.absPath, tab.title);

      const w = windowsById.get(tab.windowId);
      if (w) {
        if (w.activeTabId === tab.id) applyWindowTitle(w);
        pushShellState(w.id);
      }
      persistShellState();
      try { docClaims.record(event.sender, tab); }
      catch (err) { if (TEST_MODE) console.error("[splitpage-test] doc claim failed", err); }
    });

    ipcOn("splitpage:renderer-ready", (event) => {
      const tab = tabOf(event);
      if (!tab) return;
      tab.ready = true;
      flushPendingPayload(tab);
      if (restoreNotice.isFor(tab.id)) restoreNotice.deliver(tab);
    });

    ipcHandle("splitpage:route-open", async (event, payload) => {
      const tab = tabOf(event);
      if (!tab) throw new Error("unknown tab");
      const p = payload || {};
      if (p.kind === "file") {
        const absPath = fileIds.pathOf(p.fileId);
        if (!absPath) throw new Error("ENOENT: unknown file id");
        const result = routeOpenPath(absPath, { fromWindowId: tab.windowId, fromTabId: tab.id });
        if (!result) throw new Error("ENOENT: file is not readable");
        return { where: result.where };
      }
      throw new Error("route-open: unknown kind");
    });

    const DRAFT_STORE_DOWN: DesktopWireFailure = { ok: false, code: "EIO" };

    ipcHandle("splitpage:draft-write", async (event, payload) => {
      const tab = tabOf(event);
      if (!tab) return { ok: false, code: "NO_TAB" };
      if (!draftStore()) return DRAFT_STORE_DOWN;
      const p: Record<string, unknown> = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const seq = draftFiniteNumber(p.seq);
      const baseJson = p.baseJson === undefined || p.baseJson === null ? null : p.baseJson;
      if (seq === null || typeof p.stateJson !== "string" || (baseJson !== null && typeof baseJson !== "string")) {
        return { ok: false, code: "BAD_PAYLOAD" };
      }
      if (draftBodyTooLarge(p.stateJson) || (baseJson !== null && draftBodyTooLarge(baseJson))) {
        return { ok: false, code: "TOO_LARGE" };
      }
      return await (draftStore() as DesktopDraftStoreBoundary).write(tab.id, buildDraftHeader(tab, p), p.stateJson, baseJson, seq);
    });

    ipcHandle("splitpage:draft-discard", async (event, payload) => {
      const tab = tabOf(event);
      if (!tab) return { ok: false, code: "NO_TAB" };
      if (!draftStore()) return DRAFT_STORE_DOWN;
      const seq = draftFiniteNumber(payload && (payload as { seq?: unknown }).seq);
      if (seq === null) return { ok: false, code: "BAD_PAYLOAD" };
      if (tab.keepDraftOnClose) return { ok: false, code: "HELD" };
      return await (draftStore() as DesktopDraftStoreBoundary).discardClean(tab.id, seq);
    });

    ipcHandle("splitpage:draft-take", async (event) => {
      const tab = tabOf(event);
      if (!tab || !draftStore()) return null;
      const taken = await (draftStore() as DesktopDraftStoreBoundary).take(tab.id);
      if (!taken || taken.corrupt || taken.unsupported) return taken || null;

      const origin = (taken.header && taken.header.origin) || null;
      const filePath = origin && (origin as Record<string, unknown>).kind === "file" && typeof (origin as Record<string, unknown>).filePath === "string" ? (origin as { filePath: string }).filePath : "";
      taken.file = null;
      taken.fileProblem = null;
      if (filePath) {
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            taken.fileProblem = "unreadable";
          } else {
            const id = fileIds.register(filePath);
            taken.file = await readFileEntry(id, filePath);
            unindexTabSource(tab);
            tab.fileId = id;
            tab.source = { kind: "file", absPath: filePath };
            indexTabSource(tab);
            persistShellState();
          }
        } catch (err) {
          taken.fileProblem = err && (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
        }
      }
      if (typeof taken.previousSession !== "string") taken.previousSession = draftsPreviousSession();
      if (!("ageMs" in taken)) taken.ageMs = null;
      return taken;
    });

    ipcOn("splitpage:draft-restore-done", (event, payload) => {
      const tab = tabOf(event);
      if (!tab || !draftStore()) return;
      const outcome = payload && typeof payload.outcome === "string" ? payload.outcome : "";
      const action = restoreDoneAction(outcome);
      if (action === "open") {
        flushPendingPayload(tab, { force: true });
        return;
      }
      if (action === "release") {
        try { (draftStore() as DesktopDraftStoreBoundary).release(tab.id); } catch { }
      }
      tab.pendingPayload = null;
    });

    ipcOn("splitpage:draft-flushed", (event, reqId, result) => {
      const resolve = pendingDraftFlushes.get(reqId);
      if (!resolve) return;
      pendingDraftFlushes.delete(reqId);
      resolve(result && typeof result === "object" ? result : { ok: false });
    });
  }

  return { registerDocumentIpc };
}

export type { createDocumentIpc };

module.exports = { createDocumentIpc };
