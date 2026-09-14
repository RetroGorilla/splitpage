/* Splitpage desktop — preload script.
 *
 * Runs in an isolated world (contextIsolation: true, sandbox: true) with a
 * Node environment but no direct access to the page's globals or vice
 * versa. Its only job is to build window.splitpageDesktop and hand it to
 * the page through contextBridge — and to refuse to do even that unless
 * the page is our own origin. A tunnelled remote page (--tunnel mode loads
 * a stranger's http://localhost:<port>/ with no bridge at all, per main.js)
 * must never get file-system access just because this script happened to
 * run in its window.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.origin === "splitpage://app") {
  let openFileCallback = null;
  let menuCommandCallback = null;

  ipcRenderer.on("splitpage:open-file", (_event, entry) => {
    if (openFileCallback) openFileCallback(reviveFileEntry(entry));
  });
  ipcRenderer.on("splitpage:menu-command", (_event, command) => {
    if (menuCommandCallback) menuCommandCallback(command);
  });

  /* IPC always hands `bytes` across as a Node Buffer serialised over
     structured clone, which arrives here as a Uint8Array already in most
     Electron versions — but coerce explicitly so the page can rely on
     `entry.bytes instanceof Uint8Array` regardless. */
  function reviveFileEntry(entry) {
    if (entry && entry.bytes && !(entry.bytes instanceof Uint8Array)) {
      entry = { ...entry, bytes: new Uint8Array(entry.bytes) };
    }
    return entry;
  }

  /* Synchronous by design: appVersion is a plain string on the exposed
     object, not a promise, and this only ever runs once, at preload time,
     before the page sees it. */
  const appVersion = ipcRenderer.sendSync("splitpage:get-app-version-sync");

  /* Also synchronous, also read once at preload time, for the same reason:
     the renderer's boot sequence has to know whether the OS handed us a
     file to open BEFORE it decides whether to also try resuming the last
     project — an IPC round trip (getLastFile()) would race that decision
     instead of settling it. See main.js's own comment on the
     splitpage:has-file-to-open-sync handler. */
  const hasFileToOpen = ipcRenderer.sendSync("splitpage:has-file-to-open-sync");

  /* Also read once, at preload time: gates whether the TEST_MODE-only
     __testRequestClose/__testRequestQuit hooks below get exposed at all.
     The answer comes from the main process's own TEST_MODE flag (see
     main.js's splitpage:is-test-mode-sync), not from this script re-reading
     SPLITPAGE_TEST itself, so there is exactly one source of truth for "is
     this a test run" and preload can never disagree with main about it. */
  const testMode = ipcRenderer.sendSync("splitpage:is-test-mode-sync");

  const bridge = {
    isDesktop: true,
    platform: process.platform,
    appVersion,
    hasFileToOpen,

    openFileDialog() {
      return ipcRenderer.invoke("splitpage:open-file-dialog").then(reviveFileEntry);
    },

    saveFileDialog(options) {
      return ipcRenderer.invoke("splitpage:save-file-dialog", options || {});
    },

    readFile(id) {
      return ipcRenderer.invoke("splitpage:read-file", id).then(reviveFileEntry);
    },

    writeFile(id, data) {
      return ipcRenderer.invoke("splitpage:write-file", id, data);
    },

    statFile(id) {
      return ipcRenderer.invoke("splitpage:stat-file", id);
    },

    getLastFile() {
      return ipcRenderer.invoke("splitpage:get-last-file").then(reviveFileEntry);
    },

    setLastFile(id) {
      return ipcRenderer.invoke("splitpage:set-last-file", id);
    },

    onOpenFile(cb) {
      openFileCallback = cb;
      /* Registering this callback is the renderer's "I'm ready" signal —
         main.js has been holding any OS-handed files (launch argv, a
         second instance's argv, macOS 'open-file') in a queue exactly
         until this fires, then flushes them through the listener above. */
      ipcRenderer.send("splitpage:renderer-ready");
    },

    onMenuCommand(cb) {
      menuCommandCallback = cb;
    },

    setDocumentState(state) {
      ipcRenderer.send("splitpage:set-document-state", state);
    },

    getSessionInfo() {
      return ipcRenderer.invoke("splitpage:get-session-info");
    },

    openExternal(url) {
      ipcRenderer.send("splitpage:open-external", url);
    }
  };

  if (testMode) {
    /* Exists only so desktop/test/smoke.mjs can drive the SAME close a
       real user performs (BrowserWindow#close(), which fires the 'close'
       event main.js's dirty-document check depends on) instead of the
       page's own window.close(), which is a different, lighter-weight
       path — see main.js's splitpage:test-request-close comment. Never
       present outside SPLITPAGE_TEST=1. */
    bridge.__testRequestClose = () => ipcRenderer.send("splitpage:test-request-close");
    bridge.__testRequestQuit = () => ipcRenderer.send("splitpage:test-request-quit");
  }

  contextBridge.exposeInMainWorld("splitpageDesktop", bridge);

}
