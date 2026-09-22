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
  /* And a third, which is the point of desktop/ipc-channels.js: main hands
     this origin the rows of the channel table that name it — the nine below
     and nothing else — and every crossing here goes through them. A
     sandboxed preload cannot require that file (its `require` resolves
     'electron', 'events', 'timers' and 'url', never a file off disk), so it
     arrives the same way the window id below does, synchronously, at load.

     For the strip this is worth more than it is for preload.js: the whole
     of invariant #43 is that a compromise of this page reaches no file,
     draft or history channel, and the table is where that is now written
     down — as data, in one column, rather than as a check each of main's
     sixty handlers has to remember to make. A name this origin does not
     have throws, which takes the script down before
     contextBridge.exposeInMainWorld below and leaves the strip with no
     bridge at all. */
  const channelDirections = new Map();
  for (const entry of ipcRenderer.sendSync("splitpage:ipc-table-sync") || []) {
    if (!channelDirections.has(entry.name)) channelDirections.set(entry.name, new Set());
    channelDirections.get(entry.name).add(entry.direction);
  }

  const channel = (name, direction) => {
    const directions = channelDirections.get(name);
    if (!directions || !directions.has(direction)) {
      throw new Error("splitpage: " + name + " (" + direction + ") is not a channel this origin may use");
    }
    return name;
  };

  const invoke = (name, ...args) => ipcRenderer.invoke(channel(name, "invoke"), ...args);
  const send = (name, ...args) => ipcRenderer.send(channel(name, "send"), ...args);
  const sendSync = (name, ...args) => ipcRenderer.sendSync(channel(name, "sendSync"), ...args);
  const receive = (name, handler) => ipcRenderer.on(channel(name, "receive"), handler);

  let shellStateCallback = null;

  receive("splitpage:tabstrip-state", (_event, state) => {
    if (shellStateCallback) shellStateCallback(state);
  });

  /* Synchronous and read once, for the same reason preload.js reads its own
     boot data synchronously: tabstrip.js needs to know which window it is
     drawing before it can tell a drag that started in this strip from one
     that arrived from another window's, and that decision happens on the
     first render, long before any round trip could answer. */
  const windowId = sendSync("splitpage:tabstrip-window-id-sync");

  contextBridge.exposeInMainWorld("splitpageTabStrip", {
    windowId,
    platform: process.platform,

    getShellState() {
      return invoke("splitpage:tabstrip-get-state");
    },

    onShellStateChanged(cb) {
      shellStateCallback = cb;
    },

    newTab() {
      send("splitpage:tabstrip-new-tab");
    },

    activateTab(tabId) {
      send("splitpage:tabstrip-activate", tabId);
    },

    /* The same path as Ctrl+W and a middle click: one place decides whether
       closing a tab has to ask about unsaved work. */
    closeTab(tabId) {
      send("splitpage:tabstrip-close", tabId);
    },

    reorderTab(tabId, index) {
      send("splitpage:tabstrip-reorder", tabId, index);
    },

    /* A tab dragged out of ANOTHER window's strip and dropped on this one.
       The target window is the sender's — the strip never names it, so a
       strip page cannot move a tab into a window it is not part of. */
    moveTabHere(tabId, dropIndex) {
      send("splitpage:tabstrip-move-here", tabId, dropIndex);
    },

    tearOffToNewWindow(tabId, screenX, screenY) {
      send("splitpage:tabstrip-tear-off", tabId, screenX, screenY);
    }
  });
}
