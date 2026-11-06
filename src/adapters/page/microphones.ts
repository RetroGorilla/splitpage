import { microphoneList, recognitionTakesTrack } from "../../application/microphones.ts";
import type { BrowserBrand, MicrophoneDevices } from "../../application/microphones.ts";
import { hasVoiceRelay } from "../desktop/voice-relay.ts";
import { SpeechRecognitionCtor } from "./speech-recognition.ts";

type BrandedNavigator = Navigator & { readonly userAgentData?: { readonly brands?: readonly BrowserBrand[] } };

export function createMicrophoneDevices(given: { readonly desktop: () => boolean }): MicrophoneDevices {
  return {
    support: function () {
      if (given.desktop() || hasVoiceRelay()) return "desktop";
      const media = navigator.mediaDevices;
      const brands = (navigator as BrandedNavigator).userAgentData?.brands;
      if (!SpeechRecognitionCtor || !media || typeof media.enumerateDevices !== "function" || !recognitionTakesTrack(brands)) return "browser";
      return "yes";
    },
    list: async function () {
      try {
        const found = await navigator.mediaDevices.enumerateDevices();
        return microphoneList(found.filter((entry) => entry.kind === "audioinput"));
      } catch (e) {
        return microphoneList([]);
      }
    },
    onChange: function (listener) {
      const media = navigator.mediaDevices;
      if (!media || typeof media.addEventListener !== "function") return function () {};
      media.addEventListener("devicechange", listener);
      return function () { media.removeEventListener("devicechange", listener); };
    }
  };
}
