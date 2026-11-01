import type { PrompterVoice } from "../../application/prompter-services.ts";

type SpeechWindow = Window & { SpeechRecognition?: ReturnType<PrompterVoice["browserRecognition"]>; webkitSpeechRecognition?: ReturnType<PrompterVoice["browserRecognition"]> };

export let SpeechRecognitionCtor: ReturnType<PrompterVoice["browserRecognition"]>;

export function captureSpeechRecognition() {
  SpeechRecognitionCtor = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition || null;
}
