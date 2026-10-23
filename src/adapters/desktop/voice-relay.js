var RELAY_KEY = "splitpage-prompter-voice";
var RELAY_RE = /^(\d{1,5})-([0-9a-f]{64})$/;

var relay = null;

function parseRelay(value) {
  var m = RELAY_RE.exec(String(value || ""));
  if (!m) return null;
  var port = Number(m[1]);
  if (!(port > 0 && port < 65536)) return null;
  return { port: port, token: m[2] };
}

export function setVoiceRelay(value) {
  if (value == null) {
    var kept;
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
  return "http://127.0.0.1:" + relay.port + "/prompter-voice/" + relay.token;
}

export function createRelayRecognition() {
  if (!relay || typeof EventSource !== "function") throw new Error("no voice relay");
  var url = relayUrl();
  var rec = {
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
    _fire: function (name, arg) {
      var fn = rec[name];
      if (typeof fn === "function") fn.call(rec, arg);
    },
    _finish: function () {
      if (!rec._running) return;
      rec._running = false;
      var source = rec._source;
      rec._source = null;
      if (source) { source.onmessage = null; source.onerror = null; try { source.close(); } catch (e) {} }
      rec._fire("onend");
    },
    _handle: function (event) {
      if (!rec._running || !event || typeof event !== "object" || typeof event.type !== "string") return;
      if (event.type === "start") {
        rec._fire("onstart");
      } else if (event.type === "interim" || event.type === "final") {
        if (typeof event.text !== "string") return;
        var result = { isFinal: event.type === "final", length: 1, 0: { transcript: event.text } };
        rec._fire("onresult", { resultIndex: 0, results: [result] });
      } else if (event.type === "warning") {
        rec._fire("onwarning", { warning: event.code });
      } else if (event.type === "error") {
        rec._fire("onerror", { error: event.code });
      } else if (event.type === "end") {
        if (event.reason === "taken" || event.reason === "restarted") rec._fire("onerror", { error: "taken" });
        else if (event.reason === "revoked" || event.reason === "quit") rec._fire("onerror", { error: "relay-lost" });
        rec._finish();
      } else if (/^[a-z][a-z-]{0,31}$/.test(event.type)) {
        rec._fire("on" + event.type.replace(/-/g, ""), event);
      }
    },
    start: function () {
      if (rec._running) throw new Error("recognition has already started");
      rec._running = true;
      var source = new EventSource(url);
      rec._source = source;
      source.onmessage = function (e) {
        if (rec._source !== source) return;
        var event;
        try { event = JSON.parse(e.data); } catch (err) { return; }
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
