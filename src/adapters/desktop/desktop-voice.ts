import type { DesktopPort } from "./desktop-port.ts";
import type { PrompterRecognition } from "../../application/prompter-services.ts";

type DesktopRecognition = PrompterRecognition & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: unknown) => void) | null;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: ((event: unknown) => void) | null;
  onwarning: ((event: unknown) => void) | null;
  ondevice: ((event: unknown) => void) | null;
  _running: boolean;
  _session: number | null;
  _early: Record<string, unknown>[];
  _fire: (name: string, arg?: unknown) => void;
  _finish: () => void;
  _handle: (event: Record<string, unknown>) => void;
  abort?: () => void;
  [key: string]: unknown;
};

import { desktopPort } from "./desktop-port.ts";
import { isDesktopMicrophoneId, microphoneList } from "../../application/microphones.ts";
import type { MicrophoneList } from "../../application/microphones.ts";

let desktopVoice: { available: boolean } | null = null;
let desktopVoiceAsking: Promise<{ available: boolean }> | null = null;
let activeDesktopRecognition: DesktopRecognition | null = null;
let voiceEventBridge: DesktopPort | null = null;
let voiceOperations: Promise<void> = Promise.resolve();
const VOICE_START_TIMEOUT_MS = 15000;

function queueVoiceOperation(operation: () => Promise<unknown>) {
  // why: Cancellation is tab-wide, so an obsolete start must finish cleanup before a newer listener can start.
  voiceOperations = voiceOperations.then(operation).then(function () {}, function () {});
}

export function desktopVoiceKnown() {
  return desktopVoice !== null;
}

export function desktopVoiceAvailable() {
  return !!(desktopVoice && desktopVoice.available);
}

export function loadDesktopVoice() {
  if (desktopVoice) return Promise.resolve(desktopVoice);
  if (desktopVoiceAsking) return desktopVoiceAsking;
  const bridge = desktopPort();
  if (!bridge || typeof bridge.voiceStatus !== "function" || typeof bridge.voiceStart !== "function") {
    desktopVoice = { available: false };
    return Promise.resolve(desktopVoice);
  }
  desktopVoiceAsking = Promise.resolve()
    .then(function () { return (bridge as DesktopPort).voiceStatus(); })
    .then(function (answer) { return { available: !!(answer && answer.available) }; },
          function () { return { available: false }; })
    .then(function (known) {
      desktopVoiceAsking = null;
      if (desktopPort() === bridge) desktopVoice = known;
      return known;
    });
  return desktopVoiceAsking;
}

export function forgetDesktopVoice() {
  desktopVoice = null;
  desktopVoiceAsking = null;
  activeDesktopRecognition = null;
}

function dispatchVoiceEvent(event: unknown) {
  const rec = activeDesktopRecognition;
  if (!rec || !event || typeof event !== "object") return;
  if (rec._session === null) { rec._early.push(event as Record<string, unknown>); return; }
  if ((event as Record<string, unknown>).session === rec._session) rec._handle(event as Record<string, unknown>);
}

function wireVoiceEvents(bridge: DesktopPort | null) {
  if (voiceEventBridge === bridge || typeof (bridge as DesktopPort).onVoiceEvent !== "function") return;
  (bridge as DesktopPort).onVoiceEvent(dispatchVoiceEvent);
  voiceEventBridge = bridge;
}

const VOICE_START_ERRORS: Record<string, string> = { UNAVAILABLE: "unavailable", SPAWN_FAILED: "helper-failed", NO_TAB: "helper-failed" };

export async function listDesktopMicrophones(): Promise<MicrophoneList> {
  const bridge = desktopPort();
  if (!bridge || typeof bridge.voiceMicrophones !== "function") return microphoneList([]);
  try {
    const answer = await bridge.voiceMicrophones();
    if (!answer || !answer.ok || !Array.isArray(answer.microphones)) return microphoneList([]);
    return microphoneList(answer.microphones.filter((entry) => isDesktopMicrophoneId(entry.id))
      .map((entry) => ({ deviceId: entry.id, label: entry.name })));
  } catch (e) {
    return microphoneList([]);
  }
}

export function createDesktopRecognition(microphone: string) {
  const bridge = desktopPort();
  const wanted = isDesktopMicrophoneId(microphone) ? microphone : undefined;
  const unusable = !!microphone && !wanted;
  wireVoiceEvents(bridge);
  let startVersion = 0;
  const rec: DesktopRecognition = {
    continuous: true,
    interimResults: true,
    lang: "",
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    onwarning: null,
    ondevice: null,
    _running: false,
    _session: null,
    _early: [],
    _fire: function (name: string, arg?: unknown) {
      const fn = rec[name];
      if (typeof fn === "function") fn.call(rec, arg);
    },
    _finish: function () {
      if (!rec._running) return;
      rec._running = false;
      rec._session = null;
      if (activeDesktopRecognition === rec) activeDesktopRecognition = null;
      rec._fire("onend");
    },
    _handle: function (event: Record<string, unknown>) {
      if (!rec._running) return;
      if (event.type === "start") {
        rec._fire("onstart");
      } else if (event.type === "device") {
        if (typeof event.name === "string") rec._fire("ondevice", { name: event.name });
      } else if (event.type === "fallback") {
        rec._fire("ondevice", { fellBack: true });
      } else if (event.type === "interim" || event.type === "final") {
        if (typeof event.text !== "string") return;
        const result = { isFinal: event.type === "final", length: 1, 0: { transcript: event.text } };
        rec._fire("onresult", { resultIndex: 0, results: [result] });
      } else if (event.type === "warning") {
        rec._fire("onwarning", { warning: event.code });
      } else if (event.type === "error") {
        rec._fire("onerror", { error: event.code });
      } else if (event.type === "end") {
        if (event.reason === "taken") rec._fire("onerror", { error: "taken" });
        rec._finish();
      }
    },
    start: function () {
      if (rec._running) throw new Error("recognition has already started");
      const version = ++startVersion;
      rec._running = true;
      rec._session = null;
      rec._early = [];
      activeDesktopRecognition = rec;
      if (unusable) rec._fire("ondevice", { fellBack: true });
      queueVoiceOperation(function () {
        if (!rec._running || activeDesktopRecognition !== rec || version !== startVersion) return Promise.resolve();
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(null); }, VOICE_START_TIMEOUT_MS);
        });
        const reply = Promise.resolve()
          .then(function () { return wanted ? (bridge as DesktopPort).voiceStart(wanted) : (bridge as DesktopPort).voiceStart(); })
          .catch(function (): Awaited<ReturnType<DesktopPort["voiceStart"]>> { return { ok: false, code: "SPAWN_FAILED" }; });
        void reply.then(function (answer) {
          // why: The queue has moved on after a timeout, so late cleanup must never stop a newer listener.
          if (timedOut && answer.ok && typeof answer.session === "number") return (bridge as DesktopPort).voiceStop(answer.session);
          return;
        }).catch(function () {});
        return Promise.race([reply, timeout])
          .then(function (answer) {
            clearTimeout(timer);
            if (timedOut) {
              if (rec._running && activeDesktopRecognition === rec && version === startVersion) {
                rec._fire("onerror", { error: "helper-failed" });
                rec._finish();
              }
              return (bridge as DesktopPort).voiceStop();
            }
            if (!rec._running || activeDesktopRecognition !== rec || version !== startVersion) {
              if (answer && answer.ok) return (bridge as DesktopPort).voiceStop();
              return;
            }
            if (!answer || !answer.ok || typeof answer.session !== "number") {
              rec._fire("onerror", { error: VOICE_START_ERRORS[(answer && answer.code) as string] || "helper-failed" });
              rec._finish();
              return;
            }
            rec._session = answer.session;
            const early = rec._early;
            rec._early = [];
            early.forEach(function (event) { if (event.session === answer.session) rec._handle(event); });
          });
      });
    },
    stop: function () {
      if (!rec._running) return;
      startVersion++;
      if (rec._session !== null) queueVoiceOperation(function () { return (bridge as DesktopPort).voiceStop(); });
      rec._finish();
    }
  };
  rec.abort = rec.stop;
  return rec;
}
