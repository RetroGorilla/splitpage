"use strict";

import type { createDraftStore } from "./drafts.ts";
import type { DesktopWireCreateBundlePlan } from "../shared/desktop-contract.d.ts";

import type * as NodeCrypto from "node:crypto";

import type * as NodeFsPromises from "node:fs/promises";

import type * as NodePath from "node:path";

import type { DesktopIpcEvent, DesktopShellIpcDependencies, DesktopRegisterIpcGroup, VideoFileGrant } from "./ipc-boundaries.d.ts";

const path: typeof NodePath = require("node:path");
const fsp: typeof NodeFsPromises = require("node:fs/promises");
const crypto: typeof NodeCrypto = require("node:crypto");

const BUNDLE_JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PATH_STYLE = process.platform === "win32" ? "win32" : "posix";
const hasControlCharacter = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

function createShellIpc({
  tabOf, launchIntentFor, draftStore, draftsIsHeld, hadPriorSession, shell, nativeTheme, themeChoice,
  videoFileGrants, ATTACHABLE_FILE, openableVideoPath, bundleJobs,
  testVideoOpens, testMode: TEST_MODE, videoThumbnail,
  updateStatus, skipUpdateCheck: SKIP_UPDATE_CHECK, setUpdateStatus, checkForUpdate, downloadUpdate,
  runUpdateInstaller, openPrompterInBrowser, voiceHelperInstance
}: DesktopShellIpcDependencies) {
  function scriptOf(event: DesktopIpcEvent): string | null {
    const tab = tabOf(event);
    return tab && tab.source.kind === "file" && typeof tab.source.absPath === "string" ? tab.source.absPath : null;
  }

  function grantOf(event: DesktopIpcEvent, token: unknown): VideoFileGrant | null {
    const granted = typeof token === "string" ? videoFileGrants.get(token) : undefined;
    return granted && granted.sender === event.sender.id ? granted : null;
  }

  function sameMoveGrant(a: VideoFileGrant["move"], b: VideoFileGrant["move"]): boolean {
    if (!a || !b) return a === b;
    return a.parent === b.parent && a.stamp.size === b.stamp.size && a.stamp.mtime === b.stamp.mtime && a.stamp.ctime === b.stamp.ctime &&
      a.stamp.ino === b.stamp.ino && a.stamp.dev === b.stamp.dev;
  }

  async function openFound(found: { ok: true; path: string } | { ok: false; code: string }) {
    if (!found.ok) return found;
    if (TEST_MODE) { testVideoOpens.push(found.path); return { ok: true as const }; }
    const failed = await shell.openPath(found.path);
    return failed ? { ok: false as const, code: "OPEN_FAILED" } : { ok: true as const };
  }

  function pathGrant(event: DesktopIpcEvent, source: string): VideoFileGrant | null {
    return [...videoFileGrants.values()].findLast((g) => g.path === source && g.sender === event.sender.id && g.move) || null;
  }

  function forgetMoved(source: string): void {
    // why: the original is gone once moved, so no grant may name it again or reach the moved file in the folder
    for (const [token, grant] of videoFileGrants) if (grant.path === source) videoFileGrants.delete(token);
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
      if (!path.isAbsolute(filePath) || !ATTACHABLE_FILE.test(filePath)) return null;
      if (process.platform === "win32" && filePath.indexOf(":", 2) !== -1) return null;
      let st, real;
      try { real = await fsp.realpath(filePath); st = await fsp.stat(real); } catch { return null; }
      if (!st.isFile() || !ATTACHABLE_FILE.test(real)) return null;
      const move = await bundleJobs.moveGrantOf(filePath);
      const sender = event.sender.id;
      for (const [token, granted] of videoFileGrants) {
        if (granted.path === filePath && granted.sender === sender && sameMoveGrant(granted.move, move)) return token;
      }
      if (videoFileGrants.size >= 1000) videoFileGrants.delete(videoFileGrants.keys().next().value as string);
      const token = crypto.randomBytes(16).toString("hex");
      videoFileGrants.set(token, { path: filePath, sender, move });
      return token;
    });

    ipcHandle("splitpage:video-file-open", async (event, token) => {
      const filePath = grantOf(event, token)?.path;
      if (!filePath) return { ok: false, code: "UNKNOWN" };
      let real: string;
      try { real = await fsp.realpath(filePath); } catch { return { ok: false, code: "GONE" }; }
      if (hasControlCharacter(real) || !ATTACHABLE_FILE.test(filePath) || !ATTACHABLE_FILE.test(real)) return { ok: false, code: "REFUSED" };
      try {
        if (!(await fsp.stat(real)).isFile()) return { ok: false, code: "REFUSED" };
      } catch { return { ok: false, code: "GONE" }; }
      return openFound({ ok: true, path: real });
    });

    ipcHandle("splitpage:video-path-open", async (event, storedPath, size) => {
      const found = await openableVideoPath(storedPath, PATH_STYLE, fsp, ATTACHABLE_FILE);
      const script = !found.ok && found.code === "GONE" ? scriptOf(event) : null;
      // why: a Move can land before the script is saved with the new link, so its folder holds the file the old path named
      if (script) {
        const beside = await bundleJobs.openBeside(script, storedPath, size);
        if (beside.ok) return openFound(beside);
      }
      return openFound(found);
    });

    ipcHandle("splitpage:bundle-file", async (event, token, job) => {
      const tab = tabOf(event);
      const script = scriptOf(event);
      if (!tab || !script) return { ok: false, code: "NO_FOLDER" };
      const granted = grantOf(event, token);
      if (!granted) return { ok: false, code: "UNKNOWN" };
      if (typeof job !== "string" || !BUNDLE_JOB_RE.test(job)) return { ok: false, code: "REFUSED" };
      return bundleJobs.copy(event.sender, tab.id, job, granted.path, script);
    });

    ipcHandle("splitpage:bundle-move", async (event, token, job) => {
      const tab = tabOf(event);
      const script = scriptOf(event);
      if (!tab || !script) return { ok: false, code: "NO_FOLDER" };
      const granted = grantOf(event, token);
      if (!granted) return { ok: false, code: "UNKNOWN" };
      if (typeof job !== "string" || !BUNDLE_JOB_RE.test(job) || !granted.move) return { ok: false, code: "REFUSED" };
      const moved = () => forgetMoved(granted.path);
      return bundleJobs.move(event.sender, tab.id, job, granted.path, granted.move, script, moved);
    });

    ipcOn("splitpage:bundle-cancel", (event, job) => {
      if (typeof job === "string") bundleJobs.cancel(event.sender, job);
    });

    ipcHandle("splitpage:bundle-create-plan", async (event, paths) => {
      const script = scriptOf(event);
      if (!script) return { ok: false, code: "NO_FOLDER" };
      if (!Array.isArray(paths) || paths.length > 2000 || paths.some((p) => typeof p !== "string" || p.length > 32768)) return { ok: false, code: "REFUSED" };
      const files: { path: string; size: number; move: boolean }[] = [];
      const bundled: { path: string; name: string }[] = [];
      let missing = 0;
      for (const source of new Set(paths)) {
        const found = await bundleJobs.inspectPath(source, script);
        if (found === "missing") { missing++; continue; }
        if (!found) continue;
        if (found.name) { bundled.push({ path: source, name: found.name }); continue; }
        const grant = pathGrant(event, source);
        files.push({ path: source, size: found.size, move: !!grant && sameMoveGrant(grant.move, await bundleJobs.moveGrantOf(source)) });
      }
      if (scriptOf(event) !== script) return { ok: false, code: "DROPPED" };
      const plan: DesktopWireCreateBundlePlan = { files, bundled, missing };
      return { ok: true, plan };
    });

    ipcHandle("splitpage:bundle-path", (event, source, job, choice) => {
      const tab = tabOf(event);
      const script = scriptOf(event);
      if (!tab || !script) return { ok: false, code: "NO_FOLDER" };
      if (typeof source !== "string" || typeof job !== "string" || !BUNDLE_JOB_RE.test(job)) return { ok: false, code: "REFUSED" };
      if (choice === "copy") return bundleJobs.copy(event.sender, tab.id, job, source, script, true);
      const grant = choice === "move" ? pathGrant(event, source) : null;
      if (!grant || !grant.move) return { ok: false, code: "REFUSED" };
      return bundleJobs.move(event.sender, tab.id, job, source, grant.move, script, () => forgetMoved(source), async () => {
        const found = await bundleJobs.inspectPath(source, script);
        return !!found && found !== "missing" && !found.name && sameMoveGrant(grant.move, await bundleJobs.moveGrantOf(source));
      });
    });

    ipcHandle("splitpage:bundled-file-open", async (event, name) => {
      const tab = tabOf(event);
      const script = scriptOf(event);
      if (!tab || !script) return { ok: false, code: "REFUSED" };
      return openFound(await bundleJobs.openBundled(tab.id, script, name));
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
