/* Splitpage desktop — the IPC channel table (IPC-TABLE).
 *
 * One list of every channel that crosses the process boundary, and one
 * validator every inbound message goes through. Before this file the same
 * channel name was spelled out three times — once in preload.js, once in the
 * tab strip's preload, once in main.js — and checked in five different
 * styles, so adding a channel meant editing three files and picking a style.
 * A channel that is in this table exists everywhere; one that is not is
 * refused by main before any handler body runs.
 *
 * CommonJS, and nothing in it but plain data and small pure functions: it is
 * required by main.js, which is CommonJS throughout (house style for the
 * Electron main process). The preloads CANNOT require it. Every window and
 * every tab view in this app is made with sandbox: true, and a sandboxed
 * preload's `require` is a polyfill that resolves 'electron', 'events',
 * 'timers' and 'url' — never a file off disk. So the preloads read the table
 * the only way a sandboxed script can: main hands each origin its own slice
 * over splitpage:ipc-table-sync, which the preload reads once, synchronously,
 * before it builds anything (the same shape as the three boot reads it
 * already does). One table, two ways in, no second copy of the list.
 *
 * FIELDS
 *   name            the channel string, exactly as it goes over the wire.
 *   direction       'invoke'    renderer -> main, answered (ipcMain.handle)
 *                   'send'      renderer -> main, fire and forget
 *                   'sendSync'  renderer -> main, answered on the spot
 *                   'receive'   main -> renderer (webContents.send)
 *   argsSchema      one descriptor per argument, in order — see checkArgs.
 *                   On a 'receive' channel it documents what main sends;
 *                   main is the trusted side, so nothing validates it.
 *   allowedOrigins  which page origins may use the channel. This is the
 *                   sender check each handler used to make for itself,
 *                   moved to the one place that cannot be forgotten.
 *   refusal         'sendSync' only: what a refused caller is told. It has
 *                   to be the "I know nothing" answer that channel's preload
 *                   already falls back to, or a refusal would read as an
 *                   answer.
 *   testOnly        registered only under TEST_MODE (main.js § 14).
 *
 * A name may appear twice with two directions — splitpage:update-status is
 * both a push from main and a question the page can ask — so the table is a
 * list, and every lookup takes (name, direction).
 *
 * ARG DESCRIPTORS. A descriptor is one or more type names joined by "|",
 * optionally suffixed with "?" for "may be absent or undefined":
 *
 *   any         anything at all, including undefined
 *   string  number  integer  boolean  array  null
 *   object      a non-null, non-array object
 *   bytes       what toBuffer accepts: a string, an ArrayBuffer or a view
 *   tabId       32 hex — a tab or window id
 *   docId       /^d[0-9a-f]{32}$/ — a document id (invariant #35)
 *   snapshotId  a version-history snapshot id (invariant #38)
 *
 * `any` is not laziness: it is what a channel that must answer a bad payload
 * with a CODE rather than a rejection needs. splitpage:draft-write returns
 * {ok:false, code:'BAD_PAYLOAD'} so the renderer can back off crash recovery
 * and say so (DRAFT-STORE's WriteResult); a validator that rejected the
 * invoke first would take that code away. Those channels keep their own
 * field-by-field check in the handler, which is stricter than anything this
 * file could say — the schema just declines to answer first.
 */

"use strict";

const APP_ORIGIN = "splitpage://app";
const TABSTRIP_ORIGIN = "splitpage://tabstrip";

const APP = [APP_ORIGIN];
const STRIP = [TABSTRIP_ORIGIN];
const BOTH = [APP_ORIGIN, TABSTRIP_ORIGIN];

/* The same three expressions main.js validates ids with. They are repeated
   here rather than imported from it because the dependency only runs one way:
   main.js requires this file, never the other way round. main.js keeps its
   own checks — a schema says the id is SHAPED right, the handler still says
   whether it NAMES anything. */
const TAB_OR_WINDOW_ID_RE = /^[0-9a-f]{32}$/;
const DOC_ID_RE = /^d[0-9a-f]{32}$/;
const HISTORY_SNAP_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

const TYPES = {
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
  snapshotId: (v) => typeof v === "string" && HISTORY_SNAP_ID_RE.test(v)
};

const NONE = [];

/* ---------------------------------------------------------------------
 * The table.
 * --------------------------------------------------------------------- */

const CHANNELS = [
  /* ---- the table itself ----------------------------------------------
     The one channel a preload may name before it has the table, and the
     reason it is safe to: it hands back a list of channel descriptions and
     nothing else. A refused caller gets null, and a preload that gets null
     exposes no bridge at all. */
  { name: "splitpage:ipc-table-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: BOTH, refusal: null },

  /* ---- files (invariant #34: ids, never paths) ------------------------ */
  { name: "splitpage:open-file-dialog", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:save-file-dialog", direction: "invoke", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:read-file", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:write-file", direction: "invoke", argsSchema: ["string", "bytes"], allowedOrigins: APP },
  { name: "splitpage:stat-file", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },

  /* ---- recent documents (DESKTOP-RECENTS) ---------------------------- */
  { name: "splitpage:recents-list", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:recents-remove", direction: "invoke", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:recents-clear", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },

  /* ---- the session and the boot reads -------------------------------- */
  { name: "splitpage:get-session-info", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:get-app-version-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: APP, refusal: null },
  { name: "splitpage:tab-boot-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: APP, refusal: null },
  { name: "splitpage:is-test-mode-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: APP, refusal: false },

  { name: "splitpage:open-external", direction: "send", argsSchema: ["string"], allowedOrigins: APP },

  /* ---- updates (section 9) -------------------------------------------
     Argument-free, all four, and now that is enforced rather than merely
     written down: the page asks for the update to be downloaded and run, it
     never gets to say what is downloaded or what is run. */
  { name: "splitpage:update-status", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:update-check", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:update-download", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:update-install", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },

  /* ---- document state and routing ------------------------------------ */
  { name: "splitpage:set-document-state", direction: "send", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:renderer-ready", direction: "send", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:route-open", direction: "invoke", argsSchema: ["object"], allowedOrigins: APP },

  /* ---- crash drafts (DRAFT-IPC-AND-SHAPES) ---------------------------
     `any` on the two payloads, deliberately: see the note on `any` at the
     top of this file. Both handlers answer a malformed payload with
     {ok:false, code:'BAD_PAYLOAD'}, which a rejection would destroy. */
  { name: "splitpage:draft-write", direction: "invoke", argsSchema: ["any"], allowedOrigins: APP },
  { name: "splitpage:draft-discard", direction: "invoke", argsSchema: ["any"], allowedOrigins: APP },
  { name: "splitpage:draft-take", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:draft-restore-done", direction: "send", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:draft-flushed", direction: "send", argsSchema: ["number", "any"], allowedOrigins: APP },

  /* ---- version history (HISTORY-IPC, invariant #38) -------------------
     A malformed id REJECTS rather than answering, which is why the ids are
     typed here: the desktop backend in 03a-history-store.js turns any
     rejection into code 'invalid' and drops the entry. main.js still runs
     historyDocIdArg on every one of them — shape here, meaning there. */
  { name: "splitpage:history-put", direction: "invoke", argsSchema: ["docId", "object", "string", "array"], allowedOrigins: APP },
  { name: "splitpage:history-list", direction: "invoke", argsSchema: ["docId|null"], allowedOrigins: APP },
  { name: "splitpage:history-get", direction: "invoke", argsSchema: ["object", "snapshotId"], allowedOrigins: APP },
  { name: "splitpage:history-copy", direction: "invoke", argsSchema: ["docId", "docId"], allowedOrigins: APP },
  { name: "splitpage:history-touch", direction: "invoke", argsSchema: ["docId", "any"], allowedOrigins: APP },
  { name: "splitpage:history-import-older", direction: "invoke", argsSchema: ["array"], allowedOrigins: APP },
  { name: "splitpage:history-usage", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },
  { name: "splitpage:history-list-docs", direction: "invoke", argsSchema: NONE, allowedOrigins: APP },

  /* ---- main -> the document page -------------------------------------- */
  { name: "splitpage:open-file", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:menu-command", direction: "receive", argsSchema: ["string"], allowedOrigins: APP },
  { name: "splitpage:open-server-doc", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:restore-notice", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:update-status", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:reassign-doc-id", direction: "receive", argsSchema: ["object"], allowedOrigins: APP },
  { name: "splitpage:draft-flush", direction: "receive", argsSchema: ["number"], allowedOrigins: APP },

  /* ---- the tab strip (TABSTRIP-BRIDGE, invariant #43) -----------------
     A separate origin, and every one of these is listed for that origin
     ALONE — which is the whole of invariant #43 written as data. Nothing
     above lists TABSTRIP_ORIGIN, so no file, draft or history channel can
     be reached from the strip even if someone forgets a check in a handler.
     The strip's tab ids are typed (32 hex); main still has to find the tab. */
  { name: "splitpage:tabstrip-window-id-sync", direction: "sendSync", argsSchema: NONE, allowedOrigins: STRIP, refusal: null },
  { name: "splitpage:tabstrip-get-state", direction: "invoke", argsSchema: NONE, allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-new-tab", direction: "send", argsSchema: NONE, allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-activate", direction: "send", argsSchema: ["tabId"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-close", direction: "send", argsSchema: ["tabId"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-reorder", direction: "send", argsSchema: ["tabId", "integer"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-move-here", direction: "send", argsSchema: ["tabId", "integer"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-tear-off", direction: "send", argsSchema: ["tabId", "number", "number"], allowedOrigins: STRIP },
  { name: "splitpage:tabstrip-state", direction: "receive", argsSchema: ["object"], allowedOrigins: STRIP },

  /* ---- TEST_MODE only (desktop/test/smoke.mjs) ------------------------
     Registered only when SPLITPAGE_TEST is set, so in a normal launch these
     channels have no listener at all — testOnly is the table saying so, and
     desktop/test/ipc-table.test.mjs holds main.js to it. */
  { name: "splitpage:test-request-close", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-request-close-tab", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-request-quit", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-crash-renderer", direction: "send", argsSchema: NONE, allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-draft-status", direction: "invoke", argsSchema: ["tabId?"], allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-history-plan", direction: "invoke", argsSchema: ["object"], allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-dup-loser", direction: "invoke", argsSchema: ["object", "object"], allowedOrigins: APP, testOnly: true },
  { name: "splitpage:test-shell", direction: "invoke", argsSchema: ["string", "object|null"], allowedOrigins: APP, testOnly: true }
];

/* ---------------------------------------------------------------------
 * The validator.
 * --------------------------------------------------------------------- */

/* One argument against one descriptor. Answers null when it is fine, or the
   reason it is not — the reason is what gets logged and, for an invoke, what
   the rejection says. */
function checkArg(descriptor, value, index) {
  const optional = descriptor.endsWith("?");
  const body = optional ? descriptor.slice(0, -1) : descriptor;
  if (value === undefined) {
    return optional || body === "any" ? null : `argument ${index + 1} is missing (expected ${body})`;
  }
  for (const type of body.split("|")) {
    if (TYPES[type](value)) return null;
  }
  return `argument ${index + 1} is not ${body}`;
}

/* The whole argument list of one message. Extra arguments are a refusal, not
   a shrug: a caller sending more than the channel takes is not the caller
   this channel was written for. */
function checkArgs(argsSchema, args) {
  if (args.length > argsSchema.length) {
    return `expects ${argsSchema.length} argument(s), got ${args.length}`;
  }
  for (let i = 0; i < argsSchema.length; i++) {
    const reason = checkArg(argsSchema[i], args[i], i);
    if (reason) return reason;
  }
  return null;
}

/* ---------------------------------------------------------------------
 * Lookups, and the checks this file runs on itself at load.
 * --------------------------------------------------------------------- */

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const byKey = new Map();

for (const channel of CHANNELS) {
  const key = channel.name + " " + channel.direction;
  /* A typo in this file must stop the app at require() time, not hand a
     channel to a renderer with a schema nothing can check. */
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

/* The one entry for a (name, direction) pair, or null — a null is a channel
   nobody declared, and every caller of this treats that as a refusal. */
function channelFor(name, direction) {
  return byKey.get(name + " " + direction) || null;
}

/* Everything one origin may use, which is exactly what its preload is handed
   at load and exactly what it is allowed to expose. */
function channelsForOrigin(origin) {
  return IPC_CHANNELS.filter((c) => c.allowedOrigins.includes(origin));
}

module.exports = {
  APP_ORIGIN,
  TABSTRIP_ORIGIN,
  IPC_CHANNELS,
  channelFor,
  channelsForOrigin,
  checkArgs
};
