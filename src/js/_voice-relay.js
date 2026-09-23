/* Follow My Voice relayed from the desktop app (issue #122).
 *
 * The browser half of Present in Browser's voice relay. When the desktop app
 * opens the teleprompter in a browser and has a listener of its own
 * (Windows' recogniser, desktop/voice-helper.js), it adds
 * `voice=<port>-<64 hex>` to the fragment it opens. 20-teleprompter.js reads
 * it with the rest of the launch and hands it here; from then on this tab's
 * Follow My Voice listens through the desktop app instead of the browser's
 * Web Speech API — so it works in any browser, Firefox included, and never
 * asks the browser for the microphone (the desktop app has it).
 *
 * The relay is an EventSource on the desktop's loopback listener
 * (desktop/prompter-share.js): opening it starts the listener, closing it
 * stops it. createRelayRecognition() wraps that in the shape of a Web Speech
 * recognizer — start(), stop(), onstart/onresult/onerror/onend, plus
 * onwarning — the same shape createDesktopRecognition() (20f-desktop.js)
 * gives the desktop tab, so the teleprompter's following code runs
 * unchanged on top of it. Events are the desktop helper's own
 * ({type, session, text|code|lang|…}); a type this file does not know is
 * handed on as `on<type>` with the event, so a new one the helper learns
 * reaches the teleprompter without a change here.
 *
 * The token is a secret like the script's: it came in the fragment, which
 * no server sees, and 20-teleprompter.js takes it out of the address bar.
 * Kept in sessionStorage for a reload, like the script token.
 */

var RELAY_KEY = "splitpage-prompter-voice";
var RELAY_RE = /^(\d{1,5})-([0-9a-f]{64})$/;

var relay = null; /* {port, token} */

function parseRelay(value) {
  var m = RELAY_RE.exec(String(value || ""));
  if (!m) return null;
  var port = Number(m[1]);
  if (!(port > 0 && port < 65536)) return null;
  return { port: port, token: m[2] };
}

/* The `voice=…` value from a launch's fragment (null to recall the one this
   tab was given before a reload). */
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
  } catch (e) { /* no reload, that's all */ }
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
        /* The desktop tab, or another browser tab, started listening: this
           one is not coming back, and restarting would only take the
           microphone back from it. "revoked": the desktop shared a newer
           copy (or closed the tab) and this one's relay went with it. */
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
        /* An EventSource retries on its own; this one never should — the
           desktop app closing, or refusing an expired link, is not
           something a retry fixes, and a retry would restart a listener. */
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
