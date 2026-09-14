/* Splitpage desktop — tab strip preload script (TABSTRIP-BRIDGE).
 *
 * The tab strip is the SECOND privileged origin in this app, splitpage://
 * tabstrip (invariant #43). It is chrome, not a document: it shows which
 * documents are open and lets the user switch, close, reorder and drag
 * them, and that is the entire list.
 *
 * WHY A SEPARATE PRELOAD AT ALL, rather than reusing preload.js with a
 * couple of extra members: because the strip must not be able to reach one
 * single file, draft or history operation. preload.js exposes exactly those,
 * and every one of their main-process handlers checks isTrustedSender, which
 * accepts splitpage://app/ only. Two preloads and two trust checks mean a
 * compromise of either page reaches none of the other's powers — where one
 * shared bridge with "and don't call these from the strip" would be one
 * forgotten check away from handing the strip the file system.
 *
 * Nothing here takes a path, a document body or a secret. The only values
 * that cross are tab ids (32 hex, re-validated in main), an index, and a
 * drop point in screen coordinates.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/* The same two locks preload.js uses: this script refuses to define anything
   unless the page really is the strip's own origin, and main re-checks every
   channel anyway (isTrustedTabStripSender), so neither check stands alone. */
if (location.origin === "splitpage://tabstrip") {
  let shellStateCallback = null;

  ipcRenderer.on("splitpage:tabstrip-state", (_event, state) => {
    if (shellStateCallback) shellStateCallback(state);
  });

  /* Synchronous and read once, for the same reason preload.js reads its own
     boot data synchronously: tabstrip.js needs to know which window it is
     drawing before it can tell a drag that started in this strip from one
     that arrived from another window's, and that decision happens on the
     first render, long before any round trip could answer. */
  const windowId = ipcRenderer.sendSync("splitpage:tabstrip-window-id-sync");

  contextBridge.exposeInMainWorld("splitpageTabStrip", {
    windowId,
    platform: process.platform,

    getShellState() {
      return ipcRenderer.invoke("splitpage:tabstrip-get-state");
    },

    onShellStateChanged(cb) {
      shellStateCallback = cb;
    },

    newTab() {
      ipcRenderer.send("splitpage:tabstrip-new-tab");
    },

    activateTab(tabId) {
      ipcRenderer.send("splitpage:tabstrip-activate", tabId);
    },

    /* The same path as Ctrl+W and a middle click: one place decides whether
       closing a tab has to ask about unsaved work. */
    closeTab(tabId) {
      ipcRenderer.send("splitpage:tabstrip-close", tabId);
    },

    reorderTab(tabId, index) {
      ipcRenderer.send("splitpage:tabstrip-reorder", tabId, index);
    },

    /* A tab dragged out of ANOTHER window's strip and dropped on this one.
       The target window is the sender's — the strip never names it, so a
       strip page cannot move a tab into a window it is not part of. */
    moveTabHere(tabId, dropIndex) {
      ipcRenderer.send("splitpage:tabstrip-move-here", tabId, dropIndex);
    },

    tearOffToNewWindow(tabId, screenX, screenY) {
      ipcRenderer.send("splitpage:tabstrip-tear-off", tabId, screenX, screenY);
    }
  });
}
