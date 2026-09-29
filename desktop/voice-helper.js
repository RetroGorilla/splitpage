"use strict";

const { spawn: nodeSpawn } = require("node:child_process");

const EVENT_TYPES = new Set(["device", "start", "interim", "final", "warning", "error"]);
const CODE_RE = /^[a-z][a-z-]{0,31}$/;
const LANG_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
const MAX_TEXT = 2000;
const MAX_NAME = 120;
const MAX_LINE = 64 * 1024;
const KILL_AFTER_MS = 2000;

function parseHelperLine(line) {
  let raw;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!EVENT_TYPES.has(raw.type)) return null;
  const event = { type: raw.type };
  if (raw.type === "interim" || raw.type === "final") {
    if (typeof raw.text !== "string") return null;
    event.text = raw.text.slice(0, MAX_TEXT);
  } else if (raw.type === "device") {
    if (typeof raw.name !== "string") return null;
    /* eslint-disable-next-line no-control-regex -- stripping control characters
       from a device name the helper reports is the point */
    const name = raw.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
    if (!name) return null;
    event.name = name;
  } else if (raw.type === "start") {
    if (typeof raw.lang === "string" && LANG_RE.test(raw.lang)) event.lang = raw.lang;
  } else {
    if (typeof raw.code !== "string" || !CODE_RE.test(raw.code)) return null;
    event.code = raw.code;
  }
  return event;
}

function createVoiceHelper(opts) {
  const command = opts.command;
  const onEvent = opts.onEvent;
  const spawn = opts.spawn || nodeSpawn;
  const killAfterMs = typeof opts.killAfterMs === "number" ? opts.killAfterMs : KILL_AFTER_MS;

  let nextSession = 1;
  let current = null;
  let started = 0;

  function emit(entry, event) {
    try { onEvent(entry.tabId, Object.assign({ session: entry.session }, event)); } catch { }
  }

  function end(entry, reason) {
    if (!entry || entry.ended) return;
    entry.ended = true;
    if (current === entry) current = null;
    const child = entry.child;
    try { child.stdin.end(); } catch { }
    if (child.exitCode === null && child.signalCode === null) {
      // Grace period after stdin closes, then force kill
      entry.killTimer = setTimeout(() => { try { child.kill(); } catch { } }, killAfterMs);
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
      // Drop runaway partial line from a misbehaving helper
      if (buffer.length > MAX_LINE) buffer = "";
    });
    child.stderr.on("data", () => { });
    child.stdin.on("error", () => { });
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

  function stop(tabId) {
    if (current && current.tabId === tabId) end(current, "stopped");
    return { ok: true };
  }

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
