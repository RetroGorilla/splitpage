import { microphoneList, recognitionTakesTrack } from "../../application/microphones.ts";
import type { BrowserBrand, MicrophoneDevices } from "../../application/microphones.ts";
import { desktopVoiceAvailable, desktopVoiceKnown, listDesktopMicrophones, loadDesktopVoice } from "../desktop/desktop-voice.ts";
import { hasVoiceRelay } from "../desktop/voice-relay.ts";
import { SpeechRecognitionCtor } from "./speech-recognition.ts";

type BrandedNavigator = Navigator & { readonly userAgentData?: { readonly brands?: readonly BrowserBrand[]; readonly platform?: string } };

export function createMicrophoneDevices(given: { readonly desktop: () => boolean }): MicrophoneDevices {
  const listeners = new Set<() => void>();
  let learning = false;
  function learnDesktopVoice(): void {
    if (learning) return;
    learning = true;
    loadDesktopVoice().then(function () {
      learning = false;
      listeners.forEach(function (listener) { listener(); });
    }, function () { learning = false; });
  }
  return {
    support: function () {
      if (hasVoiceRelay()) return "relay";
      if (given.desktop()) {
        if (!desktopVoiceKnown()) learnDesktopVoice();
        return desktopVoiceAvailable() ? "yes" : "desktop";
      }
      const media = navigator.mediaDevices;
      const agent = (navigator as BrandedNavigator).userAgentData;
      if (!SpeechRecognitionCtor || !media || typeof media.enumerateDevices !== "function" || !recognitionTakesTrack(agent?.brands, agent?.platform)) return "browser";
      return "yes";
    },
    list: async function () {
      if (given.desktop()) return listDesktopMicrophones();
      try {
        const found = await navigator.mediaDevices.enumerateDevices();
        return microphoneList(found.filter((entry) => entry.kind === "audioinput"));
      } catch (e) {
        return microphoneList([]);
      }
    },
    onChange: function (listener) {
      listeners.add(listener);
      const media = navigator.mediaDevices;
      const devices = !!media && typeof media.addEventListener === "function";
      if (devices) media.addEventListener("devicechange", listener);
      return function () {
        listeners.delete(listener);
        if (devices) media.removeEventListener("devicechange", listener);
      };
    }
  };
}
