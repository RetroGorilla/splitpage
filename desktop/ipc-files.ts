"use strict";

import type * as NodeFsPromises from "node:fs/promises";

import type * as NodePath from "node:path";

import type { DesktopFileIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";
import type { DesktopFileService } from "./file-service.ts";

const path: typeof NodePath = require("node:path");
const fsp: typeof NodeFsPromises = require("node:fs/promises");
const { pathKey, readFileEntry, toBuffer, writeFileEntry }: DesktopFileService = require("./file-service.ts");

function createFileIpc({
  dialog, fileIds, pathToTabId, tabs, recents, tabOf, dialogParentFor,
  consumeTestDialogAnswer, testDialogsSeen, testMode: TEST_MODE
}: DesktopFileIpcDependencies) {
  function registerFileIpc({ ipcHandle }: Parameters<DesktopRegisterIpcGroup>[0]) {
    ipcHandle("splitpage:open-file-dialog", async (event) => {
      const answer = consumeTestDialogAnswer();
      let chosen;
      if (answer !== undefined) {
        chosen = answer;
      } else {
        const win = dialogParentFor(event);
        const result = await dialog.showOpenDialog(win, {
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
      return await writeFileEntry(absPath, buffer);
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
