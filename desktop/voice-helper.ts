"use strict";

import type * as NodeChildProcess from "node:child_process";
import type { DesktopWireMicrophone, DesktopWireMicrophones, DesktopWireVoiceEvent, DesktopWireVoiceStart, DesktopIpcResult } from "../shared/desktop-contract.d.ts";

const { spawn: nodeSpawn }: typeof NodeChildProcess = require("node:child_process");

interface DesktopVoiceSession {
  session: number;
  tabId: string;
  child: NodeChildProcess.ChildProcessWithoutNullStreams;
  ended: boolean;
  silent: boolean;
  killTimer: NodeJS.Timeout | null;
}
type DesktopVoiceHelperOptions = {
  command: () => { file: string; args?: string[]; env?: NodeJS.ProcessEnv } | null;
  onEvent: (tabId: string, event: DesktopWireVoiceEvent) => void;
  spawn?: typeof nodeSpawn;
  killAfterMs?: number;
  listTimeoutMs?: number;
};

const EVENT_TYPES = new Set<unknown>(["device", "fallback", "start", "interim", "final", "warning", "error"]);
const CODE_RE = /^[a-z][a-z-]{0,31}$/;
const LANG_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,3}$/;
const MICROPHONE_ID_RE = /^\{0\.0\.1\.00000000\}\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
const MAX_TEXT = 2000;
const MAX_NAME = 120;
const MAX_LINE = 64 * 1024;
const MAX_MICROPHONES = 64;
const KILL_AFTER_MS = 2000;
const LIST_TIMEOUT_MS = 20000;

function cleanName(value: unknown) {
  if (typeof value !== "string") return "";
  /* eslint-disable-next-line no-control-regex -- stripping control characters
     from a device name the helper reports is the point */
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
}

function parseMicrophonesLine(line: string): DesktopWireMicrophone[] | null {
  let raw: Record<string, unknown> | unknown[] | string | number | boolean | null;
  try { raw = JSON.parse(line) as typeof raw; } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.type !== "microphones" || !Array.isArray(raw.list)) return null;
  const found: DesktopWireMicrophone[] = [];
  for (const entry of raw.list as unknown[]) {
    if (found.length >= MAX_MICROPHONES) break;
    if (!entry || typeof entry !== "object") continue;
    const { id, name } = entry as Record<string, unknown>;
    const label = cleanName(name);
    if (typeof id !== "string" || !MICROPHONE_ID_RE.test(id) || !label) continue;
    if (found.some((known) => known.id.toLowerCase() === id.toLowerCase())) continue;
    found.push({ id, name: label });
  }
  return found;
}

function parseHelperLine(line: string) {
  let raw: Record<string, unknown> | unknown[] | string | number | boolean | null;
  try { raw = JSON.parse(line) as typeof raw; } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!EVENT_TYPES.has(raw.type)) return null;
  const event: Omit<DesktopWireVoiceEvent, "session"> = { type: raw.type as string };
  if (raw.type === "interim" || raw.type === "final") {
    if (typeof raw.text !== "string") return null;
    event.text = raw.text.slice(0, MAX_TEXT);
  } else if (raw.type === "device") {
    const name = cleanName(raw.name);
    if (!name) return null;
    event.name = name;
  } else if (raw.type === "fallback") {
    return event;
  } else if (raw.type === "start") {
    if (typeof raw.lang === "string" && LANG_RE.test(raw.lang)) event.lang = raw.lang;
  } else {
    if (typeof raw.code !== "string" || !CODE_RE.test(raw.code)) return null;
    event.code = raw.code;
  }
  return event;
}

function createVoiceHelper(opts: DesktopVoiceHelperOptions) {
  const command = opts.command;
  const onEvent = opts.onEvent;
  const spawn = opts.spawn || nodeSpawn;
  const killAfterMs = typeof opts.killAfterMs === "number" ? opts.killAfterMs : KILL_AFTER_MS;
  const listTimeoutMs = typeof opts.listTimeoutMs === "number" ? opts.listTimeoutMs : LIST_TIMEOUT_MS;

  let nextSession = 1;
  let current: DesktopVoiceSession | null = null;
  let started = 0;

  function emit(entry: DesktopVoiceSession, event: Omit<DesktopWireVoiceEvent, "session">) {
    try { onEvent(entry.tabId, Object.assign({ session: entry.session }, event)); } catch { }
  }

  function end(entry: DesktopVoiceSession | null, reason: string) {
    if (!entry || entry.ended) return;
    entry.ended = true;
    if (current === entry) current = null;
    const child = entry.child;
    try { child.stdin.end(); } catch { }
    if (child.exitCode === null && child.signalCode === null) {
      entry.killTimer = setTimeout(() => { try { child.kill(); } catch { } }, killAfterMs);
      if (entry.killTimer.unref) entry.killTimer.unref();
    }
    if (reason && !entry.silent) emit(entry, { type: "end", reason });
  }

  function available() {
    return !!command();
  }

  function start(tabId: string, microphone?: string): DesktopWireVoiceStart {
    const cmd = command();
    if (!cmd) return { ok: false, code: "UNAVAILABLE" };
    if (microphone !== undefined && !MICROPHONE_ID_RE.test(microphone)) return { ok: false, code: "BAD_MICROPHONE" };
    if (current) {
      const old = current;
      end(old, old.tabId === tabId ? "restarted" : "taken");
    }
    let child: DesktopVoiceSession["child"];
    try {
      child = spawn(cmd.file, (cmd.args || []).concat(microphone ? ["-Device", microphone] : []), {
        env: cmd.env || process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch {
      return { ok: false, code: "SPAWN_FAILED" };
    }
    const entry: DesktopVoiceSession = { session: nextSession++, tabId, child, ended: false, silent: false, killTimer: null };
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

  let listing: Promise<DesktopWireMicrophones> | null = null;

  function listOnce(): Promise<DesktopWireMicrophones> {
    const cmd = command();
    if (!cmd) return Promise.resolve({ ok: false, code: "UNAVAILABLE" });
    return new Promise((resolve) => {
      let child: NodeChildProcess.ChildProcessWithoutNullStreams;
      try {
        child = spawn(cmd.file, (cmd.args || []).concat(["-List"]), {
          env: cmd.env || process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      } catch {
        resolve({ ok: false, code: "SPAWN_FAILED" });
        return;
      }
      let buffer = "";
      let done = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (answer: DesktopWireMicrophones) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch { } }
        resolve(answer);
      };
      timer = setTimeout(() => finish({ ok: false, code: "LIST_FAILED" }), listTimeoutMs);
      if (timer.unref) timer.unref();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > MAX_LINE) { finish({ ok: false, code: "LIST_FAILED" }); return; }
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const found = parseMicrophonesLine(buffer.slice(0, nl).trim());
          buffer = buffer.slice(nl + 1);
          if (found) { finish({ ok: true, microphones: found }); return; }
        }
      });
      child.stderr.on("data", () => { });
      child.stdin.on("error", () => { });
      child.on("error", () => finish({ ok: false, code: "SPAWN_FAILED" }));
      child.on("exit", () => {
        const found = parseMicrophonesLine(buffer.trim());
        finish(found ? { ok: true, microphones: found } : { ok: false, code: "LIST_FAILED" });
      });
      try { child.stdin.end(); } catch { }
    });
  }

  function microphones(): Promise<DesktopWireMicrophones> {
    if (!listing) listing = listOnce().finally(() => { listing = null; });
    return listing;
  }

  function stop(tabId: string, session?: number): DesktopIpcResult<"splitpage:voice-stop"> {
    if (current && current.tabId === tabId && (session === undefined || current.session === session)) end(current, "stopped");
    return { ok: true };
  }

  function forget(tabId: string | undefined) {
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

  return { available, start, microphones, stop, forget, stopAll, status };
}

export type { createVoiceHelper, parseHelperLine, parseMicrophonesLine };

module.exports = { createVoiceHelper, parseHelperLine, parseMicrophonesLine };
