"use strict";

import type { createDraftStore } from "./drafts.ts";

import type * as NodeCrypto from "node:crypto";

import type * as NodeFsPromises from "node:fs/promises";

import type * as NodePath from "node:path";

import type { DesktopIpcEvent, DesktopShellIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";

const path: typeof NodePath = require("node:path");
const fsp: typeof NodeFsPromises = require("node:fs/promises");
const crypto: typeof NodeCrypto = require("node:crypto");

const BUNDLE_JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PATH_STYLE = process.platform === "win32" ? "win32" : "posix";
const hasControlCharacter = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

function createShellIpc({
  tabOf, launchIntentFor, draftStore, draftsIsHeld, hadPriorSession, shell, nativeTheme, themeChoice,
  videoFileGrants, VIDEO_FILE_EXT, openableVideoPath, resolveBundledFile, bundleJobs,
  testVideoOpens, testMode: TEST_MODE, videoThumbnail,
  updateStatus, skipUpdateCheck: SKIP_UPDATE_CHECK, setUpdateStatus, checkForUpdate, downloadUpdate,
  runUpdateInstaller, openPrompterInBrowser, voiceHelperInstance
}: DesktopShellIpcDependencies) {
  function scriptOf(event: DesktopIpcEvent): string | null {
    const tab = tabOf(event);
    return tab && tab.source.kind === "file" && typeof tab.source.absPath === "string" ? tab.source.absPath : null;
  }

  async function openFound(found: { ok: true; path: string } | { ok: false; code: string }) {
    if (!found.ok) return found;
    if (TEST_MODE) { testVideoOpens.push(found.path); return { ok: true as const }; }
    const failed = await shell.openPath(found.path);
    return failed ? { ok: false as const, code: "OPEN_FAILED" } : { ok: true as const };
  }

  function registerShellIpc({ ipcHandle, ipcOn, ipcOnSync }: Parameters<DesktopRegisterIpcGroup>[0]) {
    ipcOnSync("splitpage:tab-boot-sync", (event) => {
      const tab = tabOf(event);
      if (!tab) return null;
      const intent = launchIntentFor(tab);
      tab.launchIntent = intent;
      const hasDraftToRestore = intent.type === "restore-draft";
      if (draftStore()) {
        if (hasDraftToRestore) {
          try { (draftStore() as ReturnType<typeof createDraftStore>).hold(tab.id); } catch { }
        } else if (draftsIsHeld(tab.id)) {
          try { (draftStore() as ReturnType<typeof createDraftStore>).release(tab.id); } catch { }
        }
      }
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        launchIntent: intent,
        hadPriorSession: hadPriorSession(),
        firstTabOfLaunch: tab.firstTabOfLaunch === true,
        hasDraftToRestore
      };
    });

    ipcOn("splitpage:open-external", (event, url) => {
      if (typeof url === "string" && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
    });

    ipcOn("splitpage:set-theme", (event, mode) => {
      if (mode !== "system" && mode !== "light" && mode !== "dark") return;
      if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
      themeChoice.write(mode);
    });

    ipcHandle("splitpage:video-file-grant", async (event, filePath) => {
      if (!path.isAbsolute(filePath) || !VIDEO_FILE_EXT.test(filePath)) return null;
      let st;
      try { st = await fsp.stat(filePath); } catch { return null; }
      if (!st.isFile()) return null;
      for (const [token, granted] of videoFileGrants) if (granted === filePath) return token;
      if (videoFileGrants.size >= 1000) videoFileGrants.delete(videoFileGrants.keys().next().value as string);
      const token = crypto.randomBytes(16).toString("hex");
      videoFileGrants.set(token, filePath);
      return token;
    });

    ipcHandle("splitpage:video-file-open", async (event, token) => {
      const filePath = videoFileGrants.get(token);
      if (!filePath) return { ok: false, code: "UNKNOWN" };
      let real: string;
      try { real = await fsp.realpath(filePath); } catch { return { ok: false, code: "GONE" }; }
      if (hasControlCharacter(real) || !VIDEO_FILE_EXT.test(real)) return { ok: false, code: "REFUSED" };
      try {
        if (!(await fsp.stat(real)).isFile()) return { ok: false, code: "REFUSED" };
      } catch { return { ok: false, code: "GONE" }; }
      return openFound({ ok: true, path: real });
    });

    ipcHandle("splitpage:video-path-open", async (event, storedPath) => {
      return openFound(await openableVideoPath(storedPath, PATH_STYLE, fsp));
    });

    ipcHandle("splitpage:bundle-file", async (event, token, job) => {
      const tab = tabOf(event);
      const script = scriptOf(event);
      if (!tab || !script) return { ok: false, code: "NO_FOLDER" };
      const source = videoFileGrants.get(token);
      if (!source) return { ok: false, code: "UNKNOWN" };
      if (typeof job !== "string" || !BUNDLE_JOB_RE.test(job)) return { ok: false, code: "REFUSED" };
      return bundleJobs.copy(event.sender, tab.id, job, source, script);
    });

    ipcOn("splitpage:bundle-cancel", (event, job) => {
      if (typeof job === "string") bundleJobs.cancel(event.sender, job);
    });

    ipcHandle("splitpage:bundled-file-open", async (event, name) => {
      const script = scriptOf(event);
      if (!script) return { ok: false, code: "REFUSED" };
      return openFound(await resolveBundledFile(script, name, VIDEO_FILE_EXT, fsp, path, process.platform === "win32"));
    });

    ipcHandle("splitpage:video-thumbnail", async (event, host, ref) => videoThumbnail(host, ref));

    ipcHandle("splitpage:update-status", async () => {
      return updateStatus();
    });

    ipcHandle("splitpage:update-check", async () => {
      if (SKIP_UPDATE_CHECK) return updateStatus();
      setUpdateStatus({ checking: true });
      await checkForUpdate();
      return updateStatus();
    });

    ipcHandle("splitpage:update-download", async () => {
      return downloadUpdate();
    });

    ipcHandle("splitpage:update-install", async () => {
      return runUpdateInstaller();
    });

    ipcHandle("splitpage:prompter-open-in-browser", async (event) => {
      return openPrompterInBrowser(tabOf(event));
    });
    ipcHandle("splitpage:prompter-open-in-chromium", async (event) => {
      return openPrompterInBrowser(tabOf(event), { chromium: true });
    });

    ipcHandle("splitpage:voice-status", async () => {
      return { available: voiceHelperInstance().available() };
    });
    ipcHandle("splitpage:voice-start", async (event, microphone) => {
      const tab = tabOf(event);
      if (!tab) return { ok: false, code: "NO_TAB" };
      return voiceHelperInstance().start(tab.id, microphone);
    });
    ipcHandle("splitpage:voice-microphones", async () => {
      return voiceHelperInstance().microphones();
    });
    ipcHandle("splitpage:voice-stop", async (event, session) => {
      const tab = tabOf(event);
      if (!tab) return { ok: true };
      return voiceHelperInstance().stop(tab.id, session);
    });
  }

  return { registerShellIpc };
}

export type { createShellIpc };

module.exports = { createShellIpc };
