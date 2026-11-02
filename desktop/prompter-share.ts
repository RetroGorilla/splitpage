"use strict";

import type { DesktopLookupMap } from "./main-types.d.ts";

import type * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeCrypto from "node:crypto";
import type * as NodePath from "node:path";
import type { createVoiceHelper } from "./voice-helper.ts";

const http: typeof NodeHttp = require("node:http");
const net: typeof NodeNet = require("node:net");
const crypto: typeof NodeCrypto = require("node:crypto");
const path: typeof NodePath = require("node:path");

interface DesktopPrompterVoiceStream {
  res: NodeHttp.ServerResponse;
  session: number | null;
  closed: boolean;
  heartbeat: NodeJS.Timeout | null;
  close: () => void;
}
interface DesktopPrompterShareEntry {
  token: string;
  voiceToken: string | null;
  name: string;
  text: string;
  expiresAt: number;
  timer: NodeJS.Timeout | null;
  streams: Set<DesktopPrompterVoiceStream>;
}
interface DesktopPrompterShareOptions {
  staticAllowlist?: Record<string, { file: string; type: string }> | undefined;
  readStatic?: (entry: NonNullable<DesktopPrompterShareOptions["staticAllowlist"]>[string]) => Promise<Buffer>;
  cspHeader?: (() => Promise<string>) | undefined;
  preferredPort?: number;
  ttlMs?: number;
  now?: () => number;
  voice?: { start: ReturnType<typeof createVoiceHelper>["start"]; stop: (ownerId: string, session: number) => void };
}

const SHARE_TTL_MS = 60 * 60 * 1000;

const PREFERRED_PORT = 8771;
const PORT_SPAN = 20;

const MAX_SCRIPT_BYTES = 64 * 1024 * 1024;

const SHAREABLE_EXTENSIONS = [".splitpage", ".md", ".html", ".htm"];

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SCRIPT_PATH_RE = /^\/prompter-script\/([0-9a-f]{64})$/;
const VOICE_PATH_RE = /^\/prompter-voice\/([0-9a-f]{64})$/;

const VOICE_HEARTBEAT_MS = 15000;

const VOICE_START_ERRORS: Record<string, string> = { UNAVAILABLE: "unavailable", SPAWN_FAILED: "helper-failed" };

function isShareableName(name: unknown) {
  return SHAREABLE_EXTENSIONS.includes(path.extname(String(name || "")).toLowerCase());
}

function tokensEqual(a: unknown, b: unknown) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function portIsFree(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

function createPrompterShare(options?: DesktopPrompterShareOptions) {
  const opts = options || {};
  const host = "127.0.0.1";
  const readStatic = opts.readStatic;
  const cspHeader = typeof opts.cspHeader === "function" ? opts.cspHeader : async () => "";
  const preferredPort = opts.preferredPort === undefined ? PREFERRED_PORT : opts.preferredPort;
  const ttlMs = opts.ttlMs || SHARE_TTL_MS;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const voice = opts.voice && typeof opts.voice.start === "function" ? opts.voice : null;

  const staticTable: NonNullable<DesktopPrompterShareOptions["staticAllowlist"]> = {};
  for (const [route, entry] of Object.entries(opts.staticAllowlist || {})) {
    if (route === "/sw.js") continue;
    staticTable[route] = entry;
  }

  const shares: DesktopLookupMap<string, DesktopPrompterShareEntry> = new Map();
  let server: NodeHttp.Server | null = null;
  let port: number | null = null;
  let starting: Promise<number> | null = null;

  function dropShare(ownerId: string | undefined) {
    const share = shares.get(ownerId);
    if (!share) return false;
    clearTimeout(share.timer as NodeJS.Timeout | undefined);
    shares.delete(ownerId);
    endStreams(share, "revoked");
    if (!shares.size) stopServer();
    return true;
  }

  function armExpiry(ownerId: string, share: DesktopPrompterShareEntry) {
    clearTimeout(share.timer as NodeJS.Timeout | undefined);
    share.timer = setTimeout(() => {
      if (shares.get(ownerId) !== share) return;
      if (share.streams.size) { share.expiresAt = now() + ttlMs; armExpiry(ownerId, share); return; }
      dropShare(ownerId);
    }, Math.max(0, share.expiresAt - now()));
    if (typeof share.timer.unref === "function") share.timer.unref();
  }

  function writeVoice(stream: DesktopPrompterVoiceStream, event: object) {
    try { stream.res.write("data: " + JSON.stringify(event) + "\n\n"); } catch { }
  }

  function endStreams(share: DesktopPrompterShareEntry, reason: string) {
    for (const stream of [...share.streams]) {
      writeVoice(stream, { type: "end", session: stream.session, reason });
      stream.close();
    }
  }

  function shareForToken(token: string | undefined, field?: "token" | "voiceToken") {
    const key = field || "token";
    for (const [ownerId, share] of shares) {
      if (tokensEqual(share[key], token)) return { ownerId, share, expired: share.expiresAt <= now() };
    }
    return null;
  }

  function openVoiceStream(req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse, found: NonNullable<ReturnType<typeof shareForToken>>) {
    const headers = {
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store"
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const { ownerId, share } = found;
    const stream: DesktopPrompterVoiceStream = {
      res,
      session: null,
      closed: false,
      heartbeat: null,
      close() {
        if (stream.closed) return;
        stream.closed = true;
        clearInterval(stream.heartbeat as NodeJS.Timeout | undefined);
        share.streams.delete(stream);
        try { res.end(); } catch { }
        const session = stream.session;
        stream.session = null;
        if (session != null) {
          try { (voice as NonNullable<typeof voice>).stop(ownerId, session); } catch { }
        }
      }
    };
    share.streams.add(stream);
    res.on("close", () => stream.close());
    res.write(": relay\n\n");
    stream.heartbeat = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { stream.close(); }
    }, VOICE_HEARTBEAT_MS);
    if (typeof stream.heartbeat.unref === "function") stream.heartbeat.unref();
    share.expiresAt = now() + ttlMs;
    let answer: ReturnType<ReturnType<typeof createVoiceHelper>["start"]>;
    try { answer = (voice as NonNullable<typeof voice>).start(ownerId); } catch { answer = { ok: false, code: "SPAWN_FAILED" }; }
    if (stream.closed) return;
    if (!answer || !answer.ok || typeof answer.session !== "number") {
      writeVoice(stream, { type: "error", code: VOICE_START_ERRORS[(answer && (answer as Partial<Extract<typeof answer, { ok: false }>>).code) as string] || "helper-failed" });
      writeVoice(stream, { type: "end", reason: "exited" });
      stream.close();
      return;
    }
    stream.session = answer.session;
  }

  function pushVoice(ownerId: string, event: Parameters<Parameters<typeof createVoiceHelper>[0]["onEvent"]>[1]) {
    const share = shares.get(ownerId);
    if (!share || !event || typeof event !== "object") return;
    for (const stream of [...share.streams]) {
      if (stream.session == null || stream.session !== event.session) continue;
      writeVoice(stream, event);
      if (event.type === "end") { stream.session = null; stream.close(); }
    }
  }

  function hostAllowed(hostHeader: string | undefined) {
    if (typeof hostHeader !== "string" || port == null) return false;
    const h = hostHeader.toLowerCase();
    return h === `${host}:${port}` || h === `localhost:${port}`;
  }

  function send(res: NodeHttp.ServerResponse, status: number, headers: NodeHttp.OutgoingHttpHeaders, body: string | Buffer | undefined) {
    res.writeHead(status, Object.assign({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store"
    }, headers));
    res.end(body);
  }

  function notFound(res: NodeHttp.ServerResponse, json: boolean) {
    if (json) send(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "no server" }));
    else send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "not found");
  }

  async function handle(req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) {
    if (!hostAllowed(req.headers.host)) {
      send(res, 403, { "content-type": "text/plain; charset=utf-8" }, "forbidden");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, "method not allowed");
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url as string, "http://" + host).pathname); }
    catch { notFound(res, false); return; }

    if (pathname.startsWith("/api/")) { notFound(res, true); return; }

    const scriptMatch = SCRIPT_PATH_RE.exec(pathname);
    if (scriptMatch) {
      const found = shareForToken(scriptMatch[1]);
      if (!found || found.expired) {
        if (found) {
          res.once("finish", () => { if (shares.get(found.ownerId) === found.share) dropShare(found.ownerId); });
        }
        send(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "expired" }));
        return;
      }
      send(res, 200, { "content-type": "application/json; charset=utf-8" },
        req.method === "HEAD" ? undefined : JSON.stringify({ name: found.share.name, text: found.share.text }));
      return;
    }

    const voiceMatch = VOICE_PATH_RE.exec(pathname);
    if (voiceMatch) {
      const found = voice ? shareForToken(voiceMatch[1], "voiceToken") : null;
      if (!found || found.expired) {
        send(res, 404, { "content-type": "application/json" }, JSON.stringify({ error: "expired" }));
        return;
      }
      openVoiceStream(req, res, found);
      return;
    }

    const entry = staticTable[pathname === "/" ? "/index.html" : pathname];
    if (!entry || typeof readStatic !== "function") { notFound(res, false); return; }
    let body;
    try { body = await readStatic(entry); } catch { notFound(res, false); return; }
    const headers: NodeHttp.OutgoingHttpHeaders = { "content-type": entry.type, "cache-control": "no-cache" };
    if (entry.type.startsWith("text/html")) {
      const csp = await cspHeader().catch(() => "");
      if (csp) headers["content-security-policy"] = csp;
    }
    send(res, 200, headers, req.method === "HEAD" ? undefined : body);
  }

  async function ensureServer(): Promise<number> {
    if (server && port != null) return port;
    if (starting) return starting;
    starting = (async () => {
      let chosen = null;
      if (preferredPort === 0) {
        chosen = 0;
      } else {
        for (let p = preferredPort; p < preferredPort + PORT_SPAN; p++) {
          if (await portIsFree(p, host)) { chosen = p; break; }
        }
        if (chosen == null) chosen = 0;
      }
      const srv = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          try { if (!res.headersSent) notFound(res, false); else res.end(); } catch { }
        });
      });
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(chosen, host, () => { srv.removeListener("error", reject); resolve(); });
      });
      srv.keepAliveTimeout = 2000;
      server = srv;
      port = (srv.address() as NodeNet.AddressInfo).port;
      return port;
    })();
    try { return await starting; }
    finally { starting = null; }
  }

  function stopServer() {
    if (!server) return;
    const srv = server;
    server = null;
    port = null;
    try { srv.close(); } catch { }
    try { if (typeof srv.closeAllConnections === "function") srv.closeAllConnections(); } catch { }
  }

  function replaceShare(ownerId: string, share: DesktopPrompterShareEntry) {
    const previous = shares.get(ownerId);
    if (previous) {
      clearTimeout(previous.timer as NodeJS.Timeout | undefined);
      endStreams(previous, "revoked");
    }
    shares.set(ownerId, share);
    armExpiry(ownerId, share);
  }

  function voiceParam(listening: number, share: DesktopPrompterShareEntry) {
    return share.voiceToken ? `voice=${listening}-${share.voiceToken}` : "";
  }

  async function publish(ownerId: string, name: string, text: string, publishOpts?: { voice?: boolean }) {
    if (typeof ownerId !== "string" || !ownerId) throw new Error("prompter-share: no owner");
    if (!isShareableName(name)) throw new Error("prompter-share: not a project file");
    if (typeof text !== "string") throw new Error("prompter-share: no text");
    if (Buffer.byteLength(text, "utf8") > MAX_SCRIPT_BYTES) throw new Error("prompter-share: too large");
    const listening = await ensureServer();
    const withVoice = !!(voice && publishOpts && publishOpts.voice);
    const token = crypto.randomBytes(32).toString("hex");
    const share: DesktopPrompterShareEntry = {
      token,
      voiceToken: withVoice ? crypto.randomBytes(32).toString("hex") : null,
      name: path.basename(name), text, expiresAt: now() + ttlMs, timer: null, streams: new Set()
    };
    replaceShare(ownerId, share);
    const relay = voiceParam(listening, share);
    return `http://${host}:${listening}/?teleprompter=1#script=${token}` + (relay ? "&" + relay : "");
  }

  function closeAll() {
    for (const ownerId of [...shares.keys()]) {
      const share = shares.get(ownerId) as DesktopPrompterShareEntry;
      clearTimeout(share.timer as NodeJS.Timeout | undefined);
      shares.delete(ownerId);
      endStreams(share, "quit");
    }
    stopServer();
  }

  return {
    publish,
    pushVoice,
    revoke: dropShare,
    closeAll,
    status() {
      let voiceStreams = 0;
      for (const share of shares.values()) voiceStreams += share.streams.size;
      return { listening: server != null, port, shares: [...shares.keys()], voiceStreams };
    }
  };
}

export type { createPrompterShare, isShareableName, MAX_SCRIPT_BYTES, PREFERRED_PORT, SHARE_TTL_MS, TOKEN_RE };

module.exports = {
  createPrompterShare,
  isShareableName,
  MAX_SCRIPT_BYTES,
  PREFERRED_PORT,
  SHARE_TTL_MS,
  TOKEN_RE
};
