import { desktopPort } from "./desktop-port.ts";

var desktopVoice = null;
var desktopVoiceAsking = null;
var activeDesktopRecognition = null;
var voiceEventBridge = null;

export function desktopVoiceKnown() {
  return desktopVoice !== null;
}

export function desktopVoiceAvailable() {
  return !!(desktopVoice && desktopVoice.available);
}

export function loadDesktopVoice() {
  if (desktopVoice) return Promise.resolve(desktopVoice);
  if (desktopVoiceAsking) return desktopVoiceAsking;
  var bridge = desktopPort();
  if (!bridge || typeof bridge.voiceStatus !== "function" || typeof bridge.voiceStart !== "function") {
    desktopVoice = { available: false };
    return Promise.resolve(desktopVoice);
  }
  desktopVoiceAsking = Promise.resolve()
    .then(function () { return bridge.voiceStatus(); })
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

function dispatchVoiceEvent(event) {
  var rec = activeDesktopRecognition;
  if (!rec || !event || typeof event !== "object") return;
  if (rec._session === null) { rec._early.push(event); return; }
  if (event.session === rec._session) rec._handle(event);
}

function wireVoiceEvents(bridge) {
  if (voiceEventBridge === bridge || typeof bridge.onVoiceEvent !== "function") return;
  bridge.onVoiceEvent(dispatchVoiceEvent);
  voiceEventBridge = bridge;
}

var VOICE_START_ERRORS = { UNAVAILABLE: "unavailable", SPAWN_FAILED: "helper-failed", NO_TAB: "helper-failed" };

export function createDesktopRecognition() {
  var bridge = desktopPort();
  wireVoiceEvents(bridge);
  var rec = {
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
    _fire: function (name, arg) {
      var fn = rec[name];
      if (typeof fn === "function") fn.call(rec, arg);
    },
    _finish: function () {
      if (!rec._running) return;
      rec._running = false;
      rec._session = null;
      if (activeDesktopRecognition === rec) activeDesktopRecognition = null;
      rec._fire("onend");
    },
    _handle: function (event) {
      if (!rec._running) return;
      if (event.type === "start") {
        rec._fire("onstart");
      } else if (event.type === "device") {
        if (typeof event.name === "string") rec._fire("ondevice", { name: event.name });
      } else if (event.type === "interim" || event.type === "final") {
        if (typeof event.text !== "string") return;
        var result = { isFinal: event.type === "final", length: 1, 0: { transcript: event.text } };
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
      rec._running = true;
      rec._session = null;
      rec._early = [];
      activeDesktopRecognition = rec;
      Promise.resolve()
        .then(function () { return bridge.voiceStart(); })
        .catch(function () { return { ok: false, code: "SPAWN_FAILED" }; })
        .then(function (answer) {
          if (!rec._running || activeDesktopRecognition !== rec) {
            if (answer && answer.ok) bridge.voiceStop();
            return;
          }
          if (!answer || !answer.ok || typeof answer.session !== "number") {
            rec._fire("onerror", { error: VOICE_START_ERRORS[answer && answer.code] || "helper-failed" });
            rec._finish();
            return;
          }
          rec._session = answer.session;
          var early = rec._early;
          rec._early = [];
          early.forEach(function (event) { if (event.session === answer.session) rec._handle(event); });
        });
    },
    stop: function () {
      if (!rec._running) return;
      Promise.resolve().then(function () { return bridge.voiceStop(); }).catch(function () {});
      rec._finish();
    }
  };
  rec.abort = rec.stop;
  return rec;
}
