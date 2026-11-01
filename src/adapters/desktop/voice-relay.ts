import type { PrompterRecognition } from "../../application/prompter-services.ts";

type RelayVoice = PrompterRecognition & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((event: unknown) => void) | null;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: ((event: unknown) => void) | null;
  onwarning: ((event: unknown) => void) | null;
  _source: EventSource | null;
  _running: boolean;
  _fire: (name: string, arg?: unknown) => void;
  _finish: () => void;
  _handle: (event: unknown) => void;
  abort?: () => void;
  [key: string]: unknown;
};

const RELAY_KEY = "splitpage-prompter-voice";
const RELAY_RE = /^(\d{1,5})-([0-9a-f]{64})$/;

let relay: ReturnType<typeof parseRelay> = null;

function parseRelay(value: string | null | undefined) {
  const m = RELAY_RE.exec(String(value || ""));
  if (!m) return null;
  const port = Number(m[1]);
  if (!(port > 0 && port < 65536)) return null;
  return { port: port, token: m[2] };
}

export function setVoiceRelay(value: string | null) {
  if (value == null) {
    let kept;
    try { kept = sessionStorage.getItem(RELAY_KEY) || ""; } catch (e) { kept = ""; }
    relay = parseRelay(kept);
    return !!relay;
  }
  relay = parseRelay(value);
  try {
    if (relay) sessionStorage.setItem(RELAY_KEY, value);
    else sessionStorage.removeItem(RELAY_KEY);
  } catch (e) { }
  return !!relay;
}

export function hasVoiceRelay() {
  return !!relay;
}

function relayUrl() {
  return "http://127.0.0.1:" + (relay as NonNullable<typeof relay>).port + "/prompter-voice/" + (relay as NonNullable<typeof relay>).token;
}

export function createRelayRecognition() {
  if (!relay || typeof EventSource !== "function") throw new Error("no voice relay");
  const url = relayUrl();
  const rec: RelayVoice = {
    continuous: true,
    interimResults: true,
    lang: "",
    onstart: null,
    onresult: null,
    onerror: null,
    onend: null,
    onwarning: null,
    _source: null,
    _running: false,
    _fire: function (name: string, arg?: unknown) {
      const fn = rec[name];
      if (typeof fn === "function") fn.call(rec, arg);
    },
    _finish: function () {
      if (!rec._running) return;
      rec._running = false;
      const source = rec._source;
      rec._source = null;
      if (source) { source.onmessage = null; source.onerror = null; try { source.close(); } catch (e) {} }
      rec._fire("onend");
    },
    _handle: function (event: unknown) {
      if (!rec._running || !event || typeof event !== "object" || typeof (event as Record<string, unknown>).type !== "string") return;
      if ((event as Record<string, unknown>).type === "start") {
        rec._fire("onstart");
      } else if ((event as Record<string, unknown>).type === "interim" || (event as Record<string, unknown>).type === "final") {
        if (typeof (event as Record<string, unknown>).text !== "string") return;
        const result = { isFinal: (event as Record<string, unknown>).type === "final", length: 1, 0: { transcript: (event as Record<string, unknown>).text } };
        rec._fire("onresult", { resultIndex: 0, results: [result] });
      } else if ((event as Record<string, unknown>).type === "warning") {
        rec._fire("onwarning", { warning: (event as Record<string, unknown>).code });
      } else if ((event as Record<string, unknown>).type === "error") {
        rec._fire("onerror", { error: (event as Record<string, unknown>).code });
      } else if ((event as Record<string, unknown>).type === "end") {
        if ((event as Record<string, unknown>).reason === "taken" || (event as Record<string, unknown>).reason === "restarted") rec._fire("onerror", { error: "taken" });
        else if ((event as Record<string, unknown>).reason === "revoked" || (event as Record<string, unknown>).reason === "quit") rec._fire("onerror", { error: "relay-lost" });
        rec._finish();
      } else if (/^[a-z][a-z-]{0,31}$/.test((event as Record<string, unknown>).type as string)) {
        rec._fire("on" + ((event as Record<string, unknown>).type as string).replace(/-/g, ""), event);
      }
    },
    start: function () {
      if (rec._running) throw new Error("recognition has already started");
      rec._running = true;
      const source = new EventSource(url);
      rec._source = source;
      source.onmessage = function (e) {
        if (rec._source !== source) return;
        let event;
        try { event = JSON.parse(e.data as string); } catch (err) { return; }
        rec._handle(event);
      };
      source.onerror = function () {
        if (rec._source !== source) return;
        rec._fire("onerror", { error: "relay-lost" });
        rec._finish();
      };
    },
    stop: function () {
      rec._finish();
    }
  };
  rec.abort = rec.stop;
  return rec;
}
