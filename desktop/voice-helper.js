/* Splitpage desktop — Follow My Voice's listener process (issue #8).
 *
 * WHY A SEPARATE PROCESS. The Web Speech API the browser build uses exists
 * inside Electron but fails at once with a 'network' error: Google's speech
 * backend is reachable from a real Chrome or Edge install and not from here.
 * Windows has a recogniser of its own (System.Speech), offline and already
 * installed, and the simplest thing that can drive it is Windows' own
 * powershell.exe running desktop/voice/listen.ps1. That script listens to the
 * default microphone and writes what it hears to stdout as JSON lines; this
 * module runs it, reads those lines, and hands each one to main to forward
 * to the tab that asked.
 *
 * WHAT THE PAGE CAN SAY (invariant #45). Start and stop, for itself, and
 * nothing else: the channels take no argument (ipc-channels.js), and the
 * command line — the executable, the script, its arguments — is decided by
 * main from what it already holds (main.js § 9d). The worst a compromised
 * page can do is turn on the microphone listener while its own teleprompter
 * shows "Stop Following", which is what the button does anyway.
 *
 * WHAT COMES BACK (invariant #46). Only what this file rebuilds from the
 * helper's line: a type from a fixed list, a session number main assigned,
 * and one of text (a string, capped), code (a short lower-case word) or
 * lang (a culture name). Anything else on the line is dropped. The page
 * treats the text as words to match against the script, never as markup.
 *
 * ONE LISTENER AT A TIME (invariant #47). There is one microphone. A second
 * tab starting takes it over: the first tab is told its session ended
 * ("taken"), then the new one starts. A tab closing, and the app quitting,
 * end the session its tab owns. The helper also exits by itself when its
 * stdin closes, so if main dies without cleaning up, the pipe closing is
 * what stops it listening.
 *
 * Plain CommonJS, Node built-ins only, no Electron: main.js requires it, and
 * desktop/test/voice-helper.test.mjs drives it under plain node with a fake
 * helper. Listed in electron-builder.yml's `files` for the same reason
 * drafts.js is.
 */

"use strict";

const { spawn: nodeSpawn } = require("node:child_process");

const EVENT_TYPES = new Set(["start", "interim", "final", "warning", "error"]);
const CODE_RE = /^[a-z][a-z-]{0,31}$/;
const LANG_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
const MAX_TEXT = 2000;
const MAX_LINE = 64 * 1024;
const KILL_AFTER_MS = 2000;

/* One line from the helper, rebuilt field by field. Returns null for
   anything that is not a well-formed event. */
function parseHelperLine(line) {
  let raw;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!EVENT_TYPES.has(raw.type)) return null;
  const event = { type: raw.type };
  if (raw.type === "interim" || raw.type === "final") {
    if (typeof raw.text !== "string") return null;
    event.text = raw.text.slice(0, MAX_TEXT);
  } else if (raw.type === "start") {
    if (typeof raw.lang === "string" && LANG_RE.test(raw.lang)) event.lang = raw.lang;
  } else {
    if (typeof raw.code !== "string" || !CODE_RE.test(raw.code)) return null;
    event.code = raw.code;
  }
  return event;
}

/* opts.command()   {file, args, env} to run, or null when this machine has
                    no listener (not Windows, no powershell.exe). Called on
                    every start, so a test can change it.
   opts.onEvent     (tabId, event) for every event of every session,
                    including {type:"end"} when its process has gone.
   opts.spawn       child_process.spawn, replaceable in tests.
   opts.killAfterMs how long a stopped helper gets to exit on its own after
                    its stdin closes before it is killed. */
function createVoiceHelper(opts) {
  const command = opts.command;
  const onEvent = opts.onEvent;
  const spawn = opts.spawn || nodeSpawn;
  const killAfterMs = typeof opts.killAfterMs === "number" ? opts.killAfterMs : KILL_AFTER_MS;

  let nextSession = 1;
  let current = null; /* {session, tabId, child, killTimer} */
  let started = 0;

  function emit(entry, event) {
    try { onEvent(entry.tabId, Object.assign({ session: entry.session }, event)); } catch { /* a closing tab */ }
  }

  function end(entry, reason) {
    if (!entry || entry.ended) return;
    entry.ended = true;
    if (current === entry) current = null;
    const child = entry.child;
    try { child.stdin.end(); } catch { /* already closed */ }
    if (child.exitCode === null && child.signalCode === null) {
      entry.killTimer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, killAfterMs);
      if (entry.killTimer.unref) entry.killTimer.unref();
    }
    if (reason && !entry.silent) emit(entry, { type: "end", reason });
  }

  function available() {
    return !!command();
  }

  function start(tabId) {
    const cmd = command();
    if (!cmd) return { ok: false, code: "UNAVAILABLE" };
    if (current) {
      const old = current;
      end(old, old.tabId === tabId ? "restarted" : "taken");
    }
    let child;
    try {
      child = spawn(cmd.file, cmd.args || [], {
        env: cmd.env || process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      return { ok: false, code: "SPAWN_FAILED" };
    }
    const entry = { session: nextSession++, tabId, child, ended: false, silent: false, killTimer: null };
    current = entry;
    started++;

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (entry.ended || !line) continue;
        const event = parseHelperLine(line);
        if (event) emit(entry, event);
      }
      /* A helper that never ends a line is not one of ours. */
      if (buffer.length > MAX_LINE) buffer = "";
    });
    child.stderr.on("data", () => { /* drained so a chatty helper cannot block on a full pipe */ });
    child.stdin.on("error", () => { /* the helper exited first */ });
    child.on("error", () => {
      if (!entry.ended) emit(entry, { type: "error", code: "helper-failed" });
      end(entry, "exited");
    });
    child.on("exit", () => {
      if (entry.killTimer) clearTimeout(entry.killTimer);
      if (!entry.ended) end(entry, "exited");
    });
    return { ok: true, session: entry.session };
  }

  /* Only the tab that owns the session can stop it. */
  function stop(tabId) {
    if (current && current.tabId === tabId) end(current, "stopped");
    return { ok: true };
  }

  /* A tab going away: end its session without telling it. */
  function forget(tabId) {
    if (current && current.tabId === tabId) {
      current.silent = true;
      end(current, "closed");
    }
  }

  function stopAll() {
    if (current) {
      current.silent = true;
      end(current, "quit");
    }
  }

  function status() {
    return {
      available: available(),
      running: !!current,
      tabId: current ? current.tabId : null,
      session: current ? current.session : null,
      pid: current && current.child ? current.child.pid : null,
      started
    };
  }

  return { available, start, stop, forget, stopAll, status };
}

module.exports = { createVoiceHelper, parseHelperLine };
