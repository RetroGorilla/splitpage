"use strict";

import type { DesktopNativePath, DesktopNativeFsPromises } from "./native-inputs.d.ts";



import type { DesktopFileIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { DesktopFileService } from "./file-service.ts";

const path: DesktopNativePath = require("node:path");
const fsp: DesktopNativeFsPromises = require("node:fs/promises");
const { pathKey, readFileEntry, toBuffer, writeFileEntry }: DesktopFileService = require("./file-service.ts");

const OPEN_FOLDER_PROBE_TIMEOUT_MS = 1000;
const BUNDLE_JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ZIP_NAME = /\.zip$/i;

function createFileIpc({
  dialog, documentsPath, fileIds, pathToTabId, tabs, recents, tabOf, dialogParentFor,
  consumeTestDialogAnswer, testDialogsSeen, bundleJobs, testMode: TEST_MODE
}: DesktopFileIpcDependencies) {
  const pendingScriptSaves = new Set<string>();

  async function openDefaultPath() {
    const recent = recents.list()[0];
    const folders = [recents.lastSavedFolder(), recent ? path.dirname(recent.absPath) : undefined];
    for (const folder of folders) {
      if (!folder) continue;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const stat = await Promise.race([
          fsp.stat(folder),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), OPEN_FOLDER_PROBE_TIMEOUT_MS);
          })
        ]);
        if (stat?.isDirectory()) return folder;
      } catch { } finally {
        clearTimeout(timeout);
      }
    }
    return documentsPath();
  }

  function registerFileIpc({ ipcHandle }: Parameters<DesktopRegisterIpcGroup>[0]) {
    ipcHandle("splitpage:open-file-dialog", async (event) => {
      const defaultPath = await openDefaultPath();
      if (TEST_MODE) process.stdout.write(`[splitpage-test] open-dialog ${JSON.stringify({ defaultPath })}\n`);
      const answer = consumeTestDialogAnswer();
      let chosen;
      if (answer !== undefined) {
        chosen = answer;
      } else {
        const win = dialogParentFor(event);
        const result = await dialog.showOpenDialog(win, {
          defaultPath,
          properties: ["openFile"],
          filters: [
            { name: "Scripts and documents", extensions: ["splitpage", "md", "html", "htm", "docx", "txt", "csv"] }
          ]
        });
        chosen = result.canceled || !result.filePaths.length ? null : result.filePaths[0];
      }
      if (!chosen) return null;
      const id = fileIds.register(chosen);
      return await readFileEntry(id, chosen);
    });

    ipcHandle("splitpage:save-file-dialog", async (event, options) => {
      const opts = options || {};
      const answer = consumeTestDialogAnswer();
      let chosen;
      if (answer !== undefined) {
        chosen = answer;
      } else {
        const win = dialogParentFor(event);
        const result = await dialog.showSaveDialog(win, {
          defaultPath: opts.suggestedName,
          filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : undefined
        });
        chosen = result.canceled || !result.filePath ? null : result.filePath;
      }
      if (!chosen) return null;
      const holderId = pathToTabId.get(pathKey(path.resolve(chosen)));
      const holder = holderId ? tabs.get(holderId) : null;
      const me = tabOf(event);
      if (holder && (!me || holder.id !== me.id)) {
        try {
          dialog.showMessageBoxSync(dialogParentFor(event), {
            type: "warning",
            buttons: ["OK"],
            defaultId: 0,
            cancelId: 0,
            message: `${path.basename(chosen)} is already open in another tab.`,
            detail: "Saving over it from here would leave two tabs editing one file, " +
              "and each save would overwrite the other. Close that tab first, or save this " +
              "document under a different name."
          });
        } catch { }
        return null;
      }
      const id = fileIds.register(chosen);
      if (opts.script === true) bundleJobs.noteSaveTarget(id, me);
      if (opts.bundleExport === true && ZIP_NAME.test(path.basename(chosen))) bundleJobs.noteExportTarget(id, me);
      if (/\.splitpage$/i.test(path.basename(chosen))) pendingScriptSaves.add(id);
      return { id, name: path.basename(chosen) };
    });

    ipcHandle("splitpage:read-file", async (event, id) => {
      const absPath = fileIds.pathOf(id);
      if (!absPath) throw new Error("ENOENT: unknown file id");
      return await readFileEntry(id, absPath);
    });

    ipcHandle("splitpage:write-file", async (event, id, data) => {
      const absPath = fileIds.pathOf(id);
      if (!absPath) throw new Error("ENOENT: unknown file id");
      const buffer = toBuffer(data);
      const prepared = await bundleJobs.prepareWrite(id, () => buffer.toString("utf8"), event.sender);
      if (prepared.refused) return { size: 0, bundleRefused: prepared.refused };
      let written;
      try {
        written = await writeFileEntry(absPath, buffer);
      } catch (e) {
        prepared.landed(false);
        throw e;
      }
      prepared.landed(true);
      if (pendingScriptSaves.delete(id)) await recents.noteSaved(absPath);
      return written;
    });

    ipcHandle("splitpage:bundle-save-plan", async (event, id, names) => {
      return bundleJobs.planSave(id, names, tabOf(event));
    });

    ipcHandle("splitpage:bundle-save-choice", async (event, id, choice) => {
      return bundleJobs.chooseSave(id, choice, tabOf(event));
    });

    ipcHandle("splitpage:bundle-export-plan", async (event, job, scriptName, data, scriptId) => {
      const tab = tabOf(event);
      if (!tab || typeof job !== "string" || !BUNDLE_JOB_RE.test(job)) return { ok: false, code: "REFUSED" };
      return bundleJobs.planExport(event.sender, tab.id, job, scriptName, toBuffer(data).toString("utf8"), scriptId);
    });

    ipcHandle("splitpage:bundle-export", async (event, job, id) => {
      const tab = tabOf(event);
      if (!tab || typeof job !== "string" || !BUNDLE_JOB_RE.test(job)) return { ok: false, code: "REFUSED" };
      return bundleJobs.startExport(event.sender, tab.id, job, id);
    });

    ipcHandle("splitpage:stat-file", async (event, id) => {
      const absPath = fileIds.pathOf(id);
      if (!absPath) throw new Error("ENOENT: unknown file id");
      try {
        const stat = await fsp.stat(absPath);
        return { lastModified: Math.floor(stat.mtimeMs), size: stat.size };
      } catch {
        return null;
      }
    });

    ipcHandle("splitpage:recents-list", async () => {
      return recents.forRenderer();
    });

    ipcHandle("splitpage:recents-remove", async (event, fileId) => {
      if (recents.removeByFileId(fileId)) await recents.persist();
      return recents.forRenderer();
    });

    ipcHandle("splitpage:recents-clear", async () => {
      if (recents.clear()) await recents.persist();
      return recents.forRenderer();
    });

    ipcHandle("splitpage:get-session-info", async () => {
      return {
        testDialogsSeen: TEST_MODE ? testDialogsSeen() : undefined
      };
    });
  }

  return { registerFileIpc };
}

export type { createFileIpc };

module.exports = { createFileIpc };
