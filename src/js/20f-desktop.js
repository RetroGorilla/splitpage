  /* ================= desktop glue (Electron shell) =================

     Everything here is gated on DESKTOP (00-prelude.js) being non-null,
     which only happens on a document served from splitpage://app by the
     desktop shell's main process — see desktop/preload.js for the other
     half of that guarantee. When DESKTOP is null (the whole web build,
     including every suite in tests/) nothing in this file runs anything;
     every function below either returns immediately or is never called.

     The design goal throughout is "no second copy of the app's own logic":
     opening a file goes through openProjectFile() exactly the way File ▸
     Open already does; every native menu command reaches the SAME element
     the in-page File menu or header button would, by finding it and
     clicking it — real DOM clicks run every capture-phase listener several
     other fragments have already wired onto #file-menu (20c-help.js,
     20e-connect.js, 20b-onboarding.js), so this file needs no branch for
     "help" or "servers" or "setup" of its own. */

  /* ---- a FileSystemFileHandle-shaped wrapper over the bridge ----

     openProjectFile(), saveDoc() and deliverFile() all already know how to
     drive a real FileSystemFileHandle (getFile/createWritable, see
     18-local-files.js and 14-export.js) — this is the same shape, built
     over DESKTOP.readFile/writeFile instead of the File System Access API,
     so none of that calling code needs to know which one it has. `entry`
     is either a full FileEntry (from openFileDialog/onOpenFile/getLastFile
     — carries bytes already, which getFile() below ignores in favor of a
     fresh read, so a handle is never stale the moment it's minted) or the
     smaller {id, name} a fresh saveFileDialog() pick returns before
     anything has been written to disk yet. */
  function makeDesktopHandle(entry) {
    var id = entry.id;
    var name = entry.name;
    var handle = {
      kind: "file",
      name: name,
      /* Not part of the FileSystemFileHandle shape — rememberLastFileHandle()
         (00-prelude.js) and isSameEntry() below read it directly, since the
         id IS the durable thing here, the way a real handle's own internal
         identity is for the browser API. */
      _desktopId: id,
      getFile: function () {
        return DESKTOP.readFile(id).then(function (fresh) {
          name = fresh.name || name;
          handle.name = name;
          var bytes = fresh.bytes instanceof Uint8Array ? fresh.bytes : new Uint8Array(fresh.bytes || []);
          return new File([bytes], name, { lastModified: fresh.lastModified, type: mimeForFilename(name) });
        });
      },
      /* write() buffers every chunk in order and does exactly one
         DESKTOP.writeFile() on close() — the bridge contract's write is
         whole-file and atomic (temp file + rename), so there is nothing to
         gain from streaming chunks across the IPC boundary one at a time,
         and buffering keeps this the same shape as a real
         FileSystemWritableFileStream from the caller's point of view. */
      createWritable: function () {
        var chunks = [];
        return Promise.resolve({
          write: function (chunk) {
            if (typeof chunk === "string") { chunks.push(strBytes(chunk)); return Promise.resolve(); }
            if (chunk instanceof Blob) {
              return chunk.arrayBuffer().then(function (buf) { chunks.push(new Uint8Array(buf)); });
            }
            if (chunk instanceof ArrayBuffer) { chunks.push(new Uint8Array(chunk)); return Promise.resolve(); }
            if (ArrayBuffer.isView(chunk)) {
              chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
              return Promise.resolve();
            }
            chunks.push(strBytes(String(chunk)));
            return Promise.resolve();
          },
          close: function () {
            return DESKTOP.writeFile(id, concatBytes(chunks)).then(function () {});
          }
        });
      },
      queryPermission: function () { return Promise.resolve("granted"); },
      requestPermission: function () { return Promise.resolve("granted"); },
      isSameEntry: function (other) { return !!other && other._desktopId === id; }
    };
    return handle;
  }

  /* ---- resuming the last project on launch (desktop's counterpart to
     18-local-files.js's tryResumeLastProject/resumeFromHandle) ----

     No permission banner: unlike a browser's File System Access handle,
     which can genuinely lose permission between launches, the desktop app
     owns this file the same way any other desktop app owns the file it
     opened last — DESKTOP.getLastFile() already tells us whether it's still
     there. Same resumed/skipSnapshot semantics as the browser path. */
  async function tryResumeLastProjectDesktop() {
    var entry = null;
    try { entry = await DESKTOP.getLastFile(); } catch (e) { entry = null; }
    if (!entry) return;
    var handle = makeDesktopHandle(entry);
    try {
      var file = await handle.getFile();
      await openProjectFile(file, handle, { skipSnapshot: !dirty, resumed: true });
    } catch (e) {
      /* moved, renamed, or deleted since the app last quit — not worth
         interrupting startup over, same reasoning as the browser path */
    }
  }

  /* ---- window title / dirty-dot ----
     Called from setSaveButtons() (12-dirty-toast.js), the one place
     markDirty() and clearDirty() both funnel through (invariant #20). */
  function notifyDesktopDocumentState() {
    if (!DESKTOP || !state) return;
    DESKTOP.setDocumentState({ title: state.title || "Untitled Script", dirty: !!dirty });
  }

  /* ---- the native menu / header-button dispatcher ----

     Every data-file-action the desktop menu can send maps to the actual
     <button data-file-action="..."> living inside #file-menu — clicking it
     for real runs the exact chain a mouse click would: the capture-phase
     listeners 20c-help.js/20e-connect.js/20b-onboarding.js each add to
     #file-menu for "help"/"tour"/"servers"/"setup" see it FIRST (exactly as
     they do for a real click) and, for everything else, it bubbles to
     18-local-files.js's handleFileMenuAction(). Nothing here duplicates
     that dispatch or needs updating when a new File-menu action is added —
     add the button to page.html with the right data-file-action and this
     keeps working. The header buttons (save/production/gear/comments/
     write/present) have no data attribute to key off, so those five are a
     small fixed map to their own ids instead. */
  var DESKTOP_HEADER_BUTTONS = {
    "save": "btn-save",
    "toggle-production": "btn-production",
    "toggle-gear": "btn-gear",
    "toggle-comments": "btn-comments",
    "write": "btn-write",
    "present": "btn-present"
  };

  function runDesktopMenuCommand(cmd) {
    var btnId = DESKTOP_HEADER_BUTTONS[cmd];
    if (btnId) {
      var btn = document.getElementById(btnId);
      if (btn && !btn.disabled) btn.click();
      return;
    }
    var item = document.querySelector('#file-menu [data-file-action="' + cssAttr(cmd) + '"]');
    /* A disabled menu item (Save to file with nothing opened yet, etc.)
       staying inert here matches what a real click on it would do — the
       button itself refuses the click, not this dispatcher deciding for it. */
    if (item && !item.disabled) item.click();
    /* An unrecognized command from the native menu has nothing to run —
       the menu and this map are meant to agree, and a mismatch here (an
       older build's menu, say) should never take the app down over it. */
  }

  /* ---- Servers dialog: "you are sharing this session" ----

     What start.mjs used to print to the console window that launched it —
     the desktop app has no console, so this is that information's other
     home. Shown automatically once at boot when hosting (initDesktop()
     below) and reachable again any time from File ▸ Servers… (the one
     extra line in openServersDialog(), 20e-connect.js). Nothing here ever
     touches state, localStorage or anything the server hands out — the PIN
     lives only in this element's rendered text, for as long as it's on
     screen (invariant #29). */
  async function renderDesktopShareInfo() {
    var el = document.getElementById("desktop-share-info");
    if (!el || !DESKTOP) return;
    var info = null;
    try { info = await DESKTOP.getSessionInfo(); } catch (e) { info = null; }
    if (!info || !info.hosting) { el.hidden = true; el.innerHTML = ""; return; }
    var lanUrls = info.lanUrls || [];
    var addrs = lanUrls.length
      ? lanUrls.map(function (u) { return '<div class="connect-share-url">' + escapeHtml(u) + "</div>"; }).join("")
      : '<div class="modal-hint">No network address found yet — check this computer is on a network.</div>';
    var pinHtml = "";
    if (info.pin) {
      pinHtml = '<div class="connect-share-pin">Join PIN:<strong>' + escapeHtml(info.pin) + "</strong></div>" +
        '<p class="modal-hint">This code travels in the clear over plain HTTP — fine on your own ' +
        "network, not on a public one.</p>";
    } else {
      /* No PIN means server.js is running with authRequired:false — anyone
         who can reach one of the addresses above gets full read/write
         access with nothing to type in. Silently omitting this section
         (the old behavior) let that pass for "sharing", full stop, when it
         is actually the more dangerous of the two modes this dialog can be
         showing. Say so plainly rather than just leaving the PIN block out. */
      pinHtml = '<p class="modal-hint connect-share-nopin">No PIN — anyone who can reach one of ' +
        "these addresses can open and edit this document.</p>";
    }
    el.innerHTML = '<div class="connect-add-title">Sharing this session</div>' +
      '<p class="modal-hint">Others on your network can open:</p>' + addrs + pinHtml +
      '<p class="modal-hint">Closing Splitpage stops sharing.</p>';
    el.hidden = false;
  }

  /* ---- boot wiring ----
     Called once from init() (21-events.js), after every other listener in
     this build is already wired up. */
  function initDesktop() {
    if (!DESKTOP) return;

    /* Google Drive needs a real http/https origin for Google's own sign-in
       to redirect back to (Google Cloud Console has no "custom scheme"
       option for Authorized JavaScript origins) — splitpage://app cannot
       ever satisfy that, so the entry is hidden rather than left to open a
       modal whose Sign in button can only fail. openDriveModal()
       (13-hosted.js) carries the same guard defensively, in case something
       still reaches it directly. Google Doc import is different — it needs
       no OAuth at all (11-import.js's confirmGdocImport() explains why) and
       stays enabled, routed through DESKTOP.openExternal() instead of
       window.open(). */
    var driveItem = document.getElementById("menu-drive-open");
    if (driveItem) driveItem.hidden = true;

    /* Files the OS hands us — argv at launch, a second instance, macOS
       "open-file" — open exactly the way File ▸ Open does: through
       openProjectFile(), with the same snapshot/dirty safety as any other
       open. The main process queues these until this callback is
       registered, then flushes them, so nothing launched before this line
       ran is lost. */
    DESKTOP.onOpenFile(function (entry) {
      function proceed() {
        var handle = makeDesktopHandle(entry);
        handle.getFile().then(function (file) {
          return openProjectFile(file, handle);
        }).catch(function () {
          showToast("Could not open " + ((entry && entry.name) || "that file") + ".", "error");
        });
      }
      /* The main process queues an open-file event until this callback is
         registered, then flushes it — which can mean it fires the instant
         the line above runs, well before init()'s own boot load
         (loadInitialState(), 21-events.js) has finished setting `state` for
         the first time. Opening straight away in that case would just get
         overwritten a moment later when the boot load resolves and assigns
         the seed/default state over it — wait for it first (00-prelude.js's
         initialStateReady) exactly like a launch double-clicking a project
         file should behave: the file wins, not whatever the app opens to
         by default. */
      if (state) proceed();
      else if (initialStateReady) initialStateReady.then(proceed);
      else proceed();
    });

    DESKTOP.onMenuCommand(runDesktopMenuCommand);

    /* A fresh load never calls markDirty()/clearDirty() until a resume path
       runs or the reader types something — push the starting title now
       rather than leaving the window's default title showing indefinitely
       on an empty document. init()'s own loadInitialState().then() callback
       does the same once `state` exists on first load; this covers
       initDesktop() running before that promise resolves. */
    notifyDesktopDocumentState();

    /* Nobody printed the sharing address to a console the user can see —
       there isn't one — so the first time this launch is actually hosting
       anyone, say so once, unprompted. Reusing openServersDialog() means
       there is exactly one place that renders this information, not a
       second copy that could drift from what File ▸ Servers… shows. */
    DESKTOP.getSessionInfo().then(function (info) {
      if (info && info.hosting && typeof openServersDialog === "function") openServersDialog();
    }).catch(function () {});
  }

  /* ---- test hook ----
     There is no pre-load hook in the harness that can inject a real
     window.splitpageDesktop before this script runs — DESKTOP is captured
     once, at the top of 00-prelude.js, before any fragment's own top-level
     code (including this one) executes. Rather than teach the driver a new
     trick, tests/21-desktop-shim.txt swaps DESKTOP itself for an in-memory
     fake through setBackend()/restoreBackend() and drives the real code
     paths (saveDoc, deliverFile, openLocalFile, makeDesktopHandle) against
     it directly. Exists in both modes but does nothing unless a test calls
     it — same trick window.__splitpageFormats (20d-formats.js) plays. */
  function makeFakeDesktopBackend() {
    var files = {};
    var nextId = 1;
    var lastFileId = null;
    var openHandler = null;
    var menuHandler = null;
    function newId() { return "fake" + (nextId++); }
    return {
      isDesktop: true,
      platform: "test",
      appVersion: "0.0.0-test",
      hasFileToOpen: false,
      openFileDialog: function () { return Promise.resolve(null); },
      saveFileDialog: function (opts) {
        if (this._cancelNextSave) { this._cancelNextSave = false; return Promise.resolve(null); }
        var id = newId();
        files[id] = { name: (opts && opts.suggestedName) || "untitled", bytes: new Uint8Array(0), lastModified: Date.now() + nextId };
        return Promise.resolve({ id: id, name: files[id].name });
      },
      readFile: function (id) {
        var f = files[id];
        if (!f) return Promise.reject(new Error("ENOENT"));
        return Promise.resolve({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
      },
      writeFile: function (id, data) {
        var f = files[id];
        if (!f) return Promise.reject(new Error("ENOENT"));
        var bytes = data instanceof Uint8Array ? data
          : (data instanceof ArrayBuffer ? new Uint8Array(data)
          : (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(0)));
        f.bytes = bytes;
        f.lastModified = Date.now() + (nextId++);
        return Promise.resolve({ lastModified: f.lastModified, size: bytes.length });
      },
      statFile: function (id) {
        var f = files[id];
        return Promise.resolve(f ? { lastModified: f.lastModified, size: f.bytes.length } : null);
      },
      getLastFile: function () {
        var f = files[lastFileId];
        if (!f) return Promise.resolve(null);
        return Promise.resolve({ id: lastFileId, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
      },
      setLastFile: function (id) { lastFileId = id; return Promise.resolve(); },
      onOpenFile: function (cb) { openHandler = cb; },
      onMenuCommand: function (cb) { menuHandler = cb; },
      setDocumentState: function () {},
      getSessionInfo: function () {
        return Promise.resolve({ library: false, hosting: false, port: null, lanUrls: [], pin: "" });
      },
      openExternal: function () {},
      /* test-only extras below this line — nothing in src/js ever calls these */
      _addFile: function (name, text) {
        var id = newId();
        files[id] = { name: name, bytes: strBytes(text), lastModified: Date.now() + nextId };
        return id;
      },
      _text: function (id) { return new TextDecoder().decode(files[id].bytes); },
      _touch: function (id) { if (files[id]) files[id].lastModified = Date.now() + (nextId++); },
      _fireOpenFile: function (id) {
        var f = files[id];
        if (openHandler && f) openHandler({ id: id, name: f.name, lastModified: f.lastModified, size: f.bytes.length, bytes: f.bytes });
      },
      _fireMenuCommand: function (cmd) { if (menuHandler) menuHandler(cmd); }
    };
  }

  window.__desktopTest = {
    makeHandle: makeDesktopHandle,
    runMenuCommand: runDesktopMenuCommand,
    makeFakeBackend: makeFakeDesktopBackend,
    setBackend: function (fake) { DESKTOP = fake; },
    restoreBackend: function () { DESKTOP = window.splitpageDesktop || null; },
    /* Lets desktop/test/smoke.mjs dirty the document with NO DOM
       interaction at all — no click, no synthetic event dispatch — which is
       exactly the "no user activation this session" scenario the
       close-relies-on-beforeunload-activation fix (main.js's 'close'
       handler) exists for. A real click, even a JS-dispatched one, risks
       looking like user activation to Chromium; calling markDirty()
       directly never does. */
    markDirtyForTest: function () { markDirty(); }
  };
