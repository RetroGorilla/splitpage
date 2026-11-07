"use strict";

import type { DesktopChannelRow } from "../shared/desktop-contract.d.ts";

const APP_ORIGIN = "splitpage://app";
const TABSTRIP_ORIGIN = "splitpage://tabstrip";

const APP = [APP_ORIGIN];
const STRIP = [TABSTRIP_ORIGIN];
const BOTH = [APP_ORIGIN, TABSTRIP_ORIGIN];

const TAB_OR_WINDOW_ID_RE = /^[0-9a-f]{32}$/;
const DOC_ID_RE = /^d[0-9a-f]{32}$/;
const HISTORY_SNAP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VIDEO_REF_RE = /^(?:[A-Za-z0-9_-]{11}|[0-9]{1,12}(?::[0-9a-f]{6,32})?)$/;
const MICROPHONE_ID_RE = /^\{0\.0\.1\.00000000\}\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

const TYPES: Record<string, ((value: unknown) => boolean) | undefined> = {
  any: () => true,
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
  bytes: (v) => typeof v === "string" || v instanceof ArrayBuffer || ArrayBuffer.isView(v),
  tabId: (v) => typeof v === "string" && TAB_OR_WINDOW_ID_RE.test(v),
  docId: (v) => typeof v === "string" && DOC_ID_RE.test(v),
  snapshotId: (v) => typeof v === "string" && HISTORY_SNAP_ID_RE.test(v),
  sha256: (v) => typeof v === "string" && SHA256_RE.test(v),
  videoHost: (v) => v === "youtube" || v === "vimeo",
  videoRef: (v) => typeof v === "string" && VIDEO_REF_RE.test(v),
  microphoneId: (v) => typeof v === "string" && MICROPHONE_ID_RE.test(v)
};

const NONE: string[] = [];

const CHANNELS = [
  { name: "splitpage:ipc-table-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: BOTH, refusal: null },

  { name: "splitpage:open-file-dialog", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:save-file-dialog", direction: "invoke", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:read-file", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:write-file", direction: "invoke", argsSchema: ["string", "bytes"], allowedOrigins: APP },
  { name: "splitpage:stat-file", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },

  { name: "splitpage:recents-list", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:recents-remove", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:recents-clear", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },

  { name: "splitpage:get-session-info", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:get-app-version-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: APP, refusal: null },
  { name: "splitpage:tab-boot-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: APP, refusal: null },
  { name: "splitpage:is-test-mode-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: APP, refusal: false },

  { name: "splitpage:open-external", direction: "send", argsSchema: ["string"], allowedOrigins: APP },

  { name: "splitpage:set-theme", direction: "send", argsSchema: ["string"], allowedOrigins: APP },

  { name: "splitpage:video-file-grant", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:video-file-open", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:video-path-open", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:bundle-file", direction: "invoke", argsSchema: ["string", "string"], allowedOrigins: APP },
  { name: "splitpage:bundle-carry", direction: "invoke", argsSchema: ["string", "array", "string"], allowedOrigins: APP },
  { name: "splitpage:bundle-cancel", direction: "send", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:bundled-file-open", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:video-thumbnail", direction: "invoke", argsSchema: ["videoHost", "videoRef"], allowedOrigins: APP },

  { name: "splitpage:update-status", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:update-check", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:update-download", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:update-install", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },

  { name: "splitpage:prompter-open-in-browser", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:prompter-open-in-chromium", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },

  { name: "splitpage:voice-status", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:voice-start", direction: "invoke", argsSchema: ["microphoneId?"], allowedOrigins: APP },
  { name: "splitpage:voice-microphones", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:voice-stop", direction: "invoke", argsSchema: ["integer?"], allowedOrigins: APP },

  { name: "splitpage:set-document-state", direction: "send", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:renderer-ready", direction: "send", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:route-open", direction: "invoke", argsSchema: ["object"], allowedOrigins: APP },

  { name: "splitpage:draft-write", direction: "invoke", argsSchema: ["any"], allowedOrigins: APP },
  { name: "splitpage:draft-discard", direction: "invoke", argsSchema: ["any"], allowedOrigins: APP },
  { name: "splitpage:draft-take", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:draft-restore-done", direction: "send", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:draft-flushed", direction: "send", argsSchema: ["number", "any"], allowedOrigins: APP },

  { name: "splitpage:history-put", direction: "invoke", argsSchema: ["docId|null", "object", "string", "object"], allowedOrigins: APP },
  { name: "splitpage:history-list", direction: "invoke", argsSchema: ["docId|null"], allowedOrigins: APP },
  { name: "splitpage:history-get", direction: "invoke", argsSchema: ["object", "snapshotId"], allowedOrigins: APP },
  { name: "splitpage:history-copy", direction: "invoke", argsSchema: ["docId", "docId"], allowedOrigins: APP },
  { name: "splitpage:history-touch", direction: "invoke", argsSchema: ["docId", "any"], allowedOrigins: APP },
  { name: "splitpage:history-list-docs", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },

  { name: "splitpage:blob-put", direction: "invoke", argsSchema: ["sha256", "bytes"], allowedOrigins: APP },
  { name: "splitpage:blob-get", direction: "invoke", argsSchema: ["sha256"], allowedOrigins: APP },
  { name: "splitpage:blob-missing", direction: "invoke", argsSchema: ["array"], allowedOrigins: APP },

  { name: "splitpage:print-to-pdf", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },

  { name: "splitpage:open-file", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:menu-command", direction: "receive", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:restore-notice", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:update-status", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:reassign-doc-id", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:draft-flush", direction: "receive", argsSchema: ["number", "boolean?"], allowedOrigins: APP },
  { name: "splitpage:voice-event", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:bundle-progress", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },

  { name: "splitpage:tabstrip-window-id-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: STRIP, refusal: null },
  { name: "splitpage:tabstrip-get-state", direction: "invoke", argsSchema: NONE, allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-new-tab", direction: "send", argsSchema: NONE, allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-activate", direction: "send", argsSchema: ["tabId"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-close", direction: "send", argsSchema: ["tabId"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-reorder", direction: "send", argsSchema: ["tabId", "integer"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-move-here", direction: "send", argsSchema: ["tabId", "integer"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-tear-off", direction: "send", argsSchema: ["tabId", "number", "number"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-state", direction: "receive", argsSchema: ["object"], allowedOrigins: STRIP },

  { name: "splitpage:test-request-close", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-request-close-tab", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-request-quit", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-crash-renderer", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-draft-status", direction: "invoke", argsSchema: ["tabId?"], allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-dup-loser", direction: "invoke", argsSchema: ["object", "object"], allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-shell", direction: "invoke", argsSchema: ["string", "object|null"], allowedOrigins: APP, testOnly: true }
] satisfies readonly DesktopChannelRow[];

export type DesktopChannel = typeof CHANNELS[number];

function checkArg(descriptor: string, value: unknown, index: number) {
  const optional = descriptor.endsWith("?");
  const body = optional ? descriptor.slice(0, -1) : descriptor;
  if (value === undefined) {
    return optional || body === "any" ? null : `argument ${index + 1} is missing (expected ${body})`;
  }
  for (const type of body.split("|")) {
    if ((TYPES[type] as (value: unknown) => boolean)(value)) return null;
  }
  return `argument ${index + 1} is not ${body}`;
}

function checkArgs(argsSchema: readonly string[], args: readonly unknown[]) {
  if (args.length > argsSchema.length) {
    return `expects ${argsSchema.length} argument(s), got ${args.length}`;
  }
  for (let i = 0; i < argsSchema.length; i++) {
    const reason = checkArg(argsSchema[i] as string, args[i], i);
    if (reason) return reason;
  }
  return null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const byKey = new Map<string, DesktopChannelRow>();

for (const channel of CHANNELS) {
  const key = channel.name + " " + channel.direction;
  if (byKey.has(key)) throw new Error("ipc-channels: duplicate channel " + key);
  if (!["invoke", "send", "sendSync", "receive"].includes(channel.direction)) {
    throw new Error("ipc-channels: unknown direction " + key);
  }
  if (channel.direction === "sendSync" && !("refusal" in channel)) {
    throw new Error("ipc-channels: sendSync channel with no refusal value: " + key);
  }
  for (const descriptor of channel.argsSchema) {
    const body = descriptor.endsWith("?") ? descriptor.slice(0, -1) : descriptor;
    for (const type of body.split("|")) {
      if (!TYPES[type]) throw new Error("ipc-channels: unknown arg type '" + type + "' on " + key);
    }
  }
  if (!channel.allowedOrigins.length) throw new Error("ipc-channels: no origin may use " + key);
  byKey.set(key, channel);
}

const IPC_CHANNELS = deepFreeze(CHANNELS);

function channelFor(name: string, direction: DesktopChannelRow["direction"]) {
  return byKey.get(name + " " + direction) || null;
}

function channelsForOrigin(origin: string | null) {
  return IPC_CHANNELS.filter((c) => (c.allowedOrigins as readonly unknown[]).includes(origin));
}

export type DesktopChannelModule = {
  APP_ORIGIN: typeof APP_ORIGIN;
  TABSTRIP_ORIGIN: typeof TABSTRIP_ORIGIN;
  IPC_CHANNELS: typeof IPC_CHANNELS;
  channelFor: typeof channelFor;
  channelsForOrigin: typeof channelsForOrigin;
  checkArgs: typeof checkArgs;
};

module.exports = {
  APP_ORIGIN,
  TABSTRIP_ORIGIN,
  IPC_CHANNELS,
  channelFor,
  channelsForOrigin,
  checkArgs
};
