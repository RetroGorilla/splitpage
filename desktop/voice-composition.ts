"use strict";

import type * as NodePath from "node:path";
import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import type { createPrompterShare as CreatePrompterShare } from "./prompter-share.ts";
import type { createVoiceHelper as CreateVoiceHelper } from "./voice-helper.ts";
import type { DesktopMainCommon } from "./ipc-boundaries.d.ts";

const path: typeof NodePath = require("node:path");
const fs: typeof NodeFs = require("node:fs");
const fsp: typeof NodeFsPromises = require("node:fs/promises");
const { createPrompterShare }: { createPrompterShare: typeof CreatePrompterShare } = require("./prompter-share.ts");
const { createVoiceHelper }: { createVoiceHelper: typeof CreateVoiceHelper } = require("./voice-helper.ts");

const VOICE_RELAY_PREFIX = "relay:";

function createVoiceComposition({ isPackaged, appRoot, testMode, tabs, staticAllowlist, cspHeader }: Pick<DesktopMainCommon, "testMode" | "tabs"> & Pick<NonNullable<Parameters<typeof createPrompterShare>[0]>, "staticAllowlist" | "cspHeader"> & { isPackaged: boolean; appRoot: string }) {
  const VOICE_SCRIPT = isPackaged
    ? path.join(appRoot, "voice", "listen.ps1")
    : path.join(__dirname, "voice", "listen.ps1");

  let prompterShare: ReturnType<typeof createPrompterShare> | null = null;
  let voiceHelper: ReturnType<typeof createVoiceHelper> | null = null;

  function prompterShareInstance() {
    if (!prompterShare) {
      prompterShare = createPrompterShare({
        staticAllowlist,
        readStatic: (entry) => {
          const absPath = path.join(appRoot, entry.file);
          if (!absPath.startsWith(appRoot)) return Promise.reject(new Error("outside APP_ROOT"));
          return fsp.readFile(absPath);
        },
        cspHeader,
        voice: {
          start: (ownerId) => voiceHelperInstance().start(VOICE_RELAY_PREFIX + ownerId),
          stop: (ownerId, session) => {
            const helper = voiceHelperInstance();
            const st = helper.status();
            if (st.tabId === VOICE_RELAY_PREFIX + ownerId && st.session === session) helper.stop(VOICE_RELAY_PREFIX + ownerId);
          }
        }
      });
    }
    return prompterShare;
  }

  function prompterRelaysVoice() {
    return voiceHelperInstance().available();
  }

  function voiceCommand() {
    if (testMode) {
      if (!process.env.SPLITPAGE_TEST_VOICE_HELPER) return null;
      return {
        file: process.execPath,
        args: [process.env.SPLITPAGE_TEST_VOICE_HELPER],
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" })
      };
    }
    if (process.platform !== "win32") return null;
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!fs.existsSync(powershell) || !fs.existsSync(VOICE_SCRIPT)) return null;
    return {
      file: powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", VOICE_SCRIPT],
      env: process.env
    };
  }

  function voiceHelperInstance() {
    if (!voiceHelper) {
      voiceHelper = createVoiceHelper({
        command: voiceCommand,
        onEvent: (tabId, event) => {
          if (tabId.startsWith(VOICE_RELAY_PREFIX)) {
            if (prompterShare) prompterShare.pushVoice(tabId.slice(VOICE_RELAY_PREFIX.length), event);
            return;
          }
          const tab = tabs.get(tabId);
          if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
          try { tab.view.webContents.send("splitpage:voice-event", event); } catch { }
        }
      });
    }
    return voiceHelper;
  }

  function forgetTab(tabId: string | undefined) {
    if (prompterShare) prompterShare.revoke(tabId);
    if (voiceHelper) { voiceHelper.forget(tabId); voiceHelper.forget(VOICE_RELAY_PREFIX + tabId); }
  }

  return {
    prompterShare: () => prompterShare,
    voiceHelper: () => voiceHelper,
    prompterShareInstance,
    prompterRelaysVoice,
    voiceHelperInstance,
    forgetTab
  };
}

export type { createVoiceComposition, VOICE_RELAY_PREFIX };

module.exports = { createVoiceComposition, VOICE_RELAY_PREFIX };
