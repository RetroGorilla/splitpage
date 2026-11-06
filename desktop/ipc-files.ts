"use strict";

import type { DesktopNativePath, DesktopNativeFsPromises } from "./native-inputs.d.ts";



import type { DesktopFileIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { DesktopFileService } from "./file-service.ts";

const path: DesktopNativePath = require("node:path");
const fsp: DesktopNativeFsPromises = require("node:fs/promises");
const { pathKey, readFileEntry, toBuffer, writeFileEntry }: DesktopFileService = require("./file-service.ts");

function createFileIpc({
  dialog, documentsPath, fileIds, pathToTabId, tabs, recents, tabOf, dialogParentFor,
  consumeTestDialogAnswer, testDialogsSeen, testMode: TEST_MODE
}: DesktopFileIpcDependencies) {
  async function openDefaultPath() {
    const recent = recents.list()[0];
    const folders = [recents.lastSavedFolder(), recent ? path.dirname(recent.absPath) : undefined];
    for (const folder of folders) {
      if (!folder) continue;
      try {
        if ((await fsp.stat(folder)).isDirectory()) return folder;
      } catch { }
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
      const written = await writeFileEntry(absPath, buffer);
      if (/\.(splitpage|md|html|htm|docx|txt|csv)$/i.test(path.basename(absPath))) await recents.noteSaved(absPath);
      return written;
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
