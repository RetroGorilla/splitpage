import type { PrompterDesktop, PrompterVoice } from "../../../application/prompter-services.ts";
import { openPrompterInBrowser } from "../../../legacy/desktop-bridge.ts";
import { createDesktopRecognition, desktopVoiceAvailable, desktopVoiceKnown, loadDesktopVoice } from "../../../adapters/desktop/desktop-voice.js";
import { createRelayRecognition, hasVoiceRelay, setVoiceRelay } from "../../../adapters/desktop/voice-relay.js";
import { SpeechRecognitionCtor } from "../../../adapters/page/speech-recognition.js";
import { canOpenPrompterInBrowser, canOpenPrompterInChromium, desktopPort } from "../../../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../../../application/desktop-presence.ts";
import type { ExternalLinks, LaunchFacts } from "../../../application/desktop-presence.ts";
import type { RecentFiles } from "../../../application/files/recent-files.ts";

export const externalLinks: ExternalLinks = {
  available: () => typeof desktopPort()?.openExternal === "function",
  open: (url) => { desktopPort()?.openExternal?.(url); }
};

export const prompterWindows = {
  browser: () => canOpenPrompterInBrowser(),
  chromium: () => canOpenPrompterInChromium()
};

export const recents: RecentFiles = {
  available: () => typeof desktopPort()?.listRecents === "function",
  canRemove: () => typeof desktopPort()?.removeRecent === "function",
  canClear: () => typeof desktopPort()?.clearRecents === "function",
  list: () => desktopPort()?.listRecents(),
  remove: (fileId) => desktopPort()?.removeRecent(fileId),
  clear: () => desktopPort()?.clearRecents(),
  read: (id) => desktopPort()?.readFile(id),
  routeOpen: (request) => desktopPort()?.routeOpen(request)
};

export const launch: LaunchFacts = {
  firstTabOfLaunch: () => desktopPort()?.firstTabOfLaunch,
  hadPriorSession: () => desktopPort()?.hadPriorSession,
  launchIntent: () => desktopPort()?.launchIntent,
  hasDraftToRestore: () => desktopPort()?.hasDraftToRestore,
  appVersion: () => desktopPort()?.appVersion,
  sessionInfo: () => desktopPort()?.getSessionInfo()
};

export const importDesktop = {
  running: runningOnDesktop,
  openExternal: (url: string) => { const desktop = desktopPort(); if (desktop) return desktop.openExternal(url); }
};

export const prompterDesktop: PrompterDesktop = {
  running: runningOnDesktop,
  canOpen: () => canOpenPrompterInBrowser(),
  open: () => openPrompterInBrowser()
};

export const prompterVoice: PrompterVoice = {
  available: desktopVoiceAvailable,
  known: desktopVoiceKnown,
  load: loadDesktopVoice,
  createDesktop: createDesktopRecognition,
  createRelay: createRelayRecognition,
  hasRelay: hasVoiceRelay,
  setRelay: setVoiceRelay,
  browserRecognition: () => {
    const constructor: ReturnType<PrompterVoice["browserRecognition"]> = SpeechRecognitionCtor;
    return constructor;
  }
};

export const historyDesktop = { history: desktopPort, running: runningOnDesktop };
