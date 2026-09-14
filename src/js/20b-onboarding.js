  /* ================= first-run setup wizard =================

     Shown once, only over a genuinely pristine copy of the app (invariant
     #30 — the pristine-seed gate, below). Skip and Finish both write the
     same key, so neither path ever shows it again; File ▸ "Set up
     Splitpage…" reopens it on demand without touching that key.

     Like 20c-help.js and 20e-connect.js, this fragment runs its own wiring
     directly rather than through init() (21-events.js): #onboarding-modal
     and #file-menu already exist in the DOM by the time this classic
     <script> runs, which is exactly as safe as doing it from init() (see
     00-prelude.js's note on PAGE_SHELL for why a classic script can rely on
     that). The File menu's own dispatch (handleFileMenuAction(),
     18-local-files.js) has no branch for "setup" and does not need one — a
     capture-phase listener on the same #file-menu element intercepts the
     click first, exactly the pattern 20c-help.js uses for "help"/"tour".

     Everything this wizard shows either describes the app in general terms
     (never the seed document's own content — the tour's invariant #17
     applies here too, since this is also a hint that must never edit the
     document) or reaches into already-existing pieces: launcherFetch()
     (13-hosted.js) for the install step, addServerBookmark()/joinServer()/
     openServersDialog() (20e-connect.js, the one function among them added
     for this) for joining a server, and startTour()/openHelp()
     (20c-help.js) from the last step. Nothing here is called before those
     files finish loading in the browser — every reference is inside an
     event handler or an async callback, which only ever runs after every
     fragment's top-level code has executed — even though 20b sorts before
     20c/20e alphabetically; function declarations are hoisted for the whole
     shared closure regardless of which fragment they came from. */

  var ONBOARD_KEY = "splitpage-onboarding";

  function readOnboardKey() {
    var raw = null;
    try { raw = localStorage.getItem(ONBOARD_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : null;
    } catch (e) { return null; } /* unparseable counts as absent */
  }

  function writeOnboardKey(skipped) {
    try {
      localStorage.setItem(ONBOARD_KEY, JSON.stringify({
        v: 1, done: true, skipped: !!skipped, at: new Date().toISOString()
      }));
    } catch (e) { /* private browsing / full quota — it just shows again next time */ }
  }

  /* ---- the pristine-seed gate (invariant #30) ----

     build.mjs stamps <meta name="splitpage-seed-check"> with
     "<length>-<checksum>" for the exact text that ends up inside
     #state-data, using the checksumText() below (see build.mjs's own copy
     and the comment on it — the two never need to agree on an encoding,
     because both sides are plain JS strings, one built at build time and
     one read live here).

     This is what lets the wizard tell "a fresh copy of the app" from "one
     that already has somebody's script open": Phase 2 means opening a
     project file never re-embeds it into the page, so on a served/installed
     copy the only way #state-data can still read as the seed is that
     nothing has replaced it — which above all means nobody has typed into
     the seed document and saved over index.html itself (the same thing
     .githooks/pre-commit refuses to let happen in a commit). A legacy
     .html someone mails around still carries a real #state-data of its own,
     so this gate keeps working for that case even though Phase 2 saves
     never produce one again. */
  function checksumText(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  function seedCheckPasses() {
    var meta = document.querySelector('meta[name="splitpage-seed-check"]');
    var el = document.getElementById("state-data");
    if (!meta || !el) return false;
    var text = el.textContent || "";
    var expected = text.length + "-" + checksumText(text);
    return meta.getAttribute("content") === expected;
  }

  /* ---- the wizard itself ---- */

  var onboardStep = 1;
  var onboardWork = null; /* "solo" | "host" | "join" | null */
  var onboardReturnFocus = null;
  var launcherInfoState = "unloaded"; /* "unloaded" | "loading" | "done" */

  function onboardModal() { return document.getElementById("onboarding-modal"); }

  function resetOnboardUi() {
    onboardStep = 1;
    onboardWork = null;
    launcherInfoState = "unloaded";
    var hostPanel = document.getElementById("onboard-host-panel");
    var joinPanel = document.getElementById("onboard-join-panel");
    if (hostPanel) hostPanel.hidden = true;
    if (joinPanel) joinPanel.hidden = true;
    var cards = document.querySelectorAll("#onboard-work-cards .onboard-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove("is-selected");
      cards[i].setAttribute("aria-pressed", "false");
    }
    setJoinError("");
    var body = document.getElementById("onboard-install-body");
    if (body) body.innerHTML = '<p class="modal-hint">Checking how this copy was started…</p>';
  }

  function updateOnboardNav() {
    var back = document.querySelector('#onboarding-modal [data-onboard-action="back"]');
    var next = document.querySelector('#onboarding-modal [data-onboard-action="next"]');
    if (back) back.disabled = onboardStep === 1;
    if (next) next.textContent = onboardStep === 4 ? "Finish" : "Next";
  }

  function renderOnboardStep() {
    var sections = document.querySelectorAll("#onboarding-modal .onboard-step");
    for (var i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute("data-onboard-step") !== String(onboardStep);
    }
    var dots = document.querySelectorAll("#onboard-steps .onboard-dot");
    for (var j = 0; j < dots.length; j++) {
      var n = j + 1;
      dots[j].classList.toggle("is-current", n === onboardStep);
      dots[j].classList.toggle("is-done", n < onboardStep);
    }
    updateOnboardNav();
    if (onboardStep === 2) loadLauncherInfo();
  }

  /* Anything that opens over the whole screen closes the side panels first
     (invariant #16) — closeSidePanelsForHelp() (20c-help.js) already does
     exactly this and is reused rather than duplicated. */
  function openOnboarding(opts) {
    opts = opts || {};
    var modal = onboardModal();
    if (!modal) return;
    if (typeof closeSidePanelsForHelp === "function") closeSidePanelsForHelp();
    onboardReturnFocus = document.activeElement;
    resetOnboardUi();
    modal.hidden = false;
    renderOnboardStep();
    var closeBtn = modal.querySelector(".modal-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeOnboarding() {
    var modal = onboardModal();
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (onboardReturnFocus && typeof onboardReturnFocus.focus === "function") {
      try { onboardReturnFocus.focus(); } catch (e) {}
    }
    onboardReturnFocus = null;
  }

  /* Skip and Finish are the only two paths that write the key — everything
     else (the "Open the user guide" / "Servers…" links) just hides the
     modal so it can be picked back up from the File menu, and shows again
     on the next pristine load exactly as if nothing had happened yet. */
  function finishOnboarding(skipped) {
    writeOnboardKey(skipped);
    closeOnboarding();
  }

  function onboardSkip() { finishOnboarding(true); }

  function onboardNext() {
    if (onboardStep < 4) { onboardStep++; renderOnboardStep(); return; }
    finishOnboarding(false);
  }

  function onboardBack() {
    if (onboardStep > 1) { onboardStep--; renderOnboardStep(); }
  }

  function onboardFinishAndTour() {
    finishOnboarding(false);
    if (typeof startTour === "function") startTour();
  }

  /* ---- step 2: portable, or add to the Start Menu ----

     GET api/launcher/info answers only when this copy was started by
     start.mjs and the request is on loopback (13-hosted.js's
     launcherFetch()) — a 404/offline here just means "not available in
     this copy" (opened from file://, the PowerShell fallback, a hosted
     copy, or the test harness, none of which are the launcher), not an
     error worth alarming over. */
  function noLauncherHtml() {
    return '<p class="modal-hint">This copy of Splitpage runs wherever its folder is — ' +
      "copy it anywhere and it still works. Splitpage cannot register itself in the " +
      "Start Menu from here, because this page was not opened by the launcher (a " +
      "browser tab reached over <code>file://</code>, a hosted copy, or a plain static " +
      "server all look like this). To add it to your Start Menu instead: run " +
      "<code>start.bat</code> once from that folder, then come back to " +
      '<strong>Setup ▸ Add to Start Menu</strong> — or run the <code>SplitpageSetup</code> ' +
      "installer, which does the same thing without a command line.</p>";
  }

  function renderLauncherInfoBody(html) {
    var el = document.getElementById("onboard-install-body");
    if (el) el.innerHTML = html;
  }

  /* The desktop app has no launcher and no /api/launcher/* routes to ask —
     it is already the thing the launcher's Start Menu step exists to
     produce, so the honest answer is "you already have this", not a
     register button that would 404. */
  function desktopInstallHtml() {
    return '<p class="modal-hint">Splitpage is already installed as a desktop app — this is it. ' +
      "Opening a <code>.splitpage</code> file (or a Markdown script saved from here) opens it " +
      "with Splitpage automatically.</p>";
  }

  function renderLauncherInfo(info) {
    var html = '<p class="modal-hint">Running from <code>' + escapeHtml(info.root || "") + "</code>.</p>";
    if (info.installed) {
      html += '<p class="modal-hint">Already in your Start Menu — nothing else to do.</p>';
    } else if (info.canRegister) {
      html += '<p class="modal-hint">Add this copy to your Start Menu so it shows up, and ' +
        "uninstalls, like any other app — the files stay right where they are.</p>" +
        '<button type="button" class="btn btn-accent" data-onboard-action="register">Add to Start Menu</button>';
    } else {
      html += '<p class="modal-hint">This copy can stay exactly where it is.</p>';
    }
    renderLauncherInfoBody(html);
  }

  async function loadLauncherInfo() {
    if (launcherInfoState !== "unloaded") return;
    launcherInfoState = "loading";
    if (DESKTOP) {
      launcherInfoState = "done";
      renderLauncherInfoBody(desktopInstallHtml());
      return;
    }
    var info = null;
    try { info = await launcherFetch("api/launcher/info"); }
    catch (e) { info = null; }
    launcherInfoState = "done";
    if (onboardStep !== 2) return; /* Back/Next moved on while this was in flight */
    if (!info) renderLauncherInfoBody(noLauncherHtml());
    else renderLauncherInfo(info);
  }

  async function registerLauncher() {
    var btn = document.querySelector('#onboard-install-body [data-onboard-action="register"]');
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    try {
      await launcherFetch("api/launcher/register", { method: "POST" });
      renderLauncherInfoBody('<p class="modal-hint">Registered — Splitpage is now in your Start Menu.</p>');
      if (typeof showToast === "function") showToast("Added to the Start Menu.", "ok");
    } catch (e) {
      var msg = (e && e.message) || "could not register";
      renderLauncherInfoBody('<p class="modal-hint">Could not add it: ' + escapeHtml(msg) + "</p>" +
        '<button type="button" class="btn btn-accent" data-onboard-action="register">Try again</button>');
      if (typeof showToast === "function") showToast("Could not add to the Start Menu.", "warn");
    }
  }

  /* ---- step 3: how you'll be working ---- */

  function selectOnboardWork(kind) {
    onboardWork = kind;
    var cards = document.querySelectorAll("#onboard-work-cards .onboard-card");
    for (var i = 0; i < cards.length; i++) {
      var is = cards[i].getAttribute("data-onboard-work") === kind;
      cards[i].classList.toggle("is-selected", is);
      cards[i].setAttribute("aria-pressed", is ? "true" : "false");
    }
    var hostPanel = document.getElementById("onboard-host-panel");
    var joinPanel = document.getElementById("onboard-join-panel");
    if (hostPanel) hostPanel.hidden = kind !== "host";
    if (joinPanel) joinPanel.hidden = kind !== "join";
  }

  function onboardHostCommandText() {
    var el = document.getElementById("onboard-host-cmd");
    return el ? el.textContent : "start.bat --host --pin";
  }

  /* Same clipboard-then-textarea fallback as copySshCommand()
     (20e-connect.js) — small enough, and specific enough to this one
     string, that sharing the function was not worth reaching into that
     file for. */
  async function copyOnboardHostCmd() {
    var text = onboardHostCommandText();
    try {
      await navigator.clipboard.writeText(text);
      if (typeof showToast === "function") showToast("Command copied.", "ok");
      return;
    } catch (e) { /* fall through */ }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "readonly");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      if (typeof showToast === "function") showToast("Command copied.", "ok");
    } catch (err) {
      if (typeof showToast === "function") showToast("Could not copy — select the command and copy it by hand.", "warn");
    }
  }

  function saveOnboardHostCmd() {
    var text = onboardHostCommandText();
    var lines = [
      "@echo off",
      "title Splitpage - host for others",
      "echo Starting a shared session...",
      "echo Share the address and the PIN it prints with whoever is joining.",
      "echo This is plain HTTP - fine on your own network, not over the internet.",
      "echo Close this window to stop hosting.",
      "echo.",
      text,
      "pause"
    ];
    deliverFile("splitpage-host.cmd", lines.join("\r\n") + "\r\n", { savedMsg: "Saved the host command." });
  }

  function setJoinError(message) {
    var el = document.getElementById("onboard-join-error");
    if (!el) return;
    el.textContent = message || "";
    el.hidden = !message;
  }

  /* Reuses addServerBookmark() (20e-connect.js) — the one function added
     there for this wizard — so joining and bookmarking a server is exactly
     one code path whether it starts here or from the Servers dialog. */
  async function submitOnboardJoin() {
    var name = document.getElementById("onboard-join-name").value;
    var url = document.getElementById("onboard-join-url").value.trim();
    var pin = document.getElementById("onboard-join-pin").value.trim();
    var remember = !!document.getElementById("onboard-join-remember").checked;
    if (!url) { setJoinError("An address is needed — something like http://192.168.1.20:8791/"); return; }
    setJoinError("");
    var btn = document.querySelector('#onboard-join-panel [data-onboard-action="join-submit"]');
    var was = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Joining…"; }
    var result;
    try {
      result = await addServerBookmark(name, url, { pin: pin, remember: remember });
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    }
    if (!result.ok) {
      setJoinError(typeof joinErrorText === "function" ? joinErrorText(result.error) : ("Could not join: " + result.error));
      return;
    }
    if (typeof showToast === "function") {
      showToast("Joined" + (result.bookmark ? " " + result.bookmark.name : "") + ".", "ok");
    }
    onboardStep = 4;
    renderOnboardStep();
  }

  /* ---- wiring ---- */

  (function wireOnboardingModal() {
    var modal = onboardModal();
    if (!modal) return;

    modal.addEventListener("click", function (e) {
      var action = e.target.closest("[data-onboard-action]");
      if (action) {
        var name = action.getAttribute("data-onboard-action");
        if (name === "skip") onboardSkip();
        else if (name === "back") onboardBack();
        else if (name === "next") onboardNext();
        else if (name === "register") registerLauncher();
        else if (name === "host-copy") copyOnboardHostCmd();
        else if (name === "host-save") saveOnboardHostCmd();
        else if (name === "join-submit") submitOnboardJoin();
        else if (name === "finish-tour") onboardFinishAndTour();
        else if (name === "open-servers") { e.preventDefault(); closeOnboarding(); if (typeof openServersDialog === "function") openServersDialog(); }
        else if (name === "open-help") { e.preventDefault(); closeOnboarding(); if (typeof openHelp === "function") openHelp(); }
        return;
      }
      var card = e.target.closest("[data-onboard-work]");
      if (card) { selectOnboardWork(card.getAttribute("data-onboard-work")); return; }
      /* Clicking the backdrop dismisses the wizard the same way Esc does —
         it is exactly as much "I'm done with this" as pressing Escape. */
      if (e.target === modal) onboardSkip();
    });

    modal.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var joinPanel = document.getElementById("onboard-join-panel");
      if (joinPanel && !joinPanel.hidden && joinPanel.contains(e.target)) {
        e.preventDefault();
        submitOnboardJoin();
      }
    });

    /* Esc = skip (this wizard's own rule). Bubble phase, no
       stopPropagation() — same shape as help's and the tour's own Escape
       handlers, deliberately NOT capture-phase like 20e-connect.js's. This
       modal auto-opens over an otherwise-idle app, unlike every other one
       here, so a capture-phase listener that stops the event would swallow
       Escape for the whole page while it happens to be up in the
       background — that's exactly what broke `07-untagged.txt`'s "Escape
       dismisses the untagged-mention suggestion" (handled by a keydown
       listener on `#rows`, which a capture-phase stop on `window` never
       let the event reach). Letting it reach whatever it was actually sent
       to first, and only acting here once it has bubbled all the way up
       unstopped, means the wizard never swallows a key meant for something
       underneath it — by the time nothing else has claimed it, focus really
       is inside the wizard. */
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) { e.preventDefault(); onboardSkip(); }
    });

    /* A modal owns focus, not just the pixels (invariant #19) — but as a
       Tab-key wraparound inside the modal, not a document-wide focusin trap
       like help's/connect's. Those never auto-open, so nothing outside them
       ever legitimately needs focus while they're up; this one auto-opens
       over an otherwise-idle app, and a reactive "yank focus back" trap
       fights ANY unrelated part of the page that focuses itself while the
       wizard happens to be sitting open in the background — including a
       test's `caret` on a script cell, which is exactly what broke
       `07-untagged.txt` (typing still worked via the Selection API, but
       focus itself had been dragged onto the modal's own close button, so
       the untagged-suggestion Escape handler on `#rows` never saw the key).
       The backdrop's own CSS already stops a real click from reaching
       anything behind it; this only needs to keep Tab from walking a
       keyboard user out the back of the modal into the page underneath. */
    modal.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var focusables = Array.prototype.filter.call(
        modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        function (el) { return !el.disabled && el.offsetParent !== null; }
      );
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  })();

  /* File ▸ "Set up Splitpage…" — same capture-phase pattern as the Help
     items in 20c-help.js: intercept the click on #file-menu before
     18-local-files.js's own bubble-phase listener (handleFileMenuAction())
     ever sees it, so that file needs no branch for "setup" at all.

     Every OTHER File-menu action gets one thing piggybacked onto it too:
     if the wizard is still open (nobody has been through Skip or Finish
     yet), choosing anything from this menu — Help, the tour, Servers…,
     Open, Save, all of it — closes it first, without writing the key. Help
     and the tour are the only other full-screen modals in the app and both
     only ever open from here, so this is the one place that can guarantee
     what invariant #19 asks for: never two of them open at once. Without
     it, a test (or, in principle, a user) that reaches a File-menu item
     while the wizard is still showing underneath ends up with two modals
     live together, each with its own Escape/focus-trap listener fighting
     the other for which one Escape actually closes — this is what broke
     14-help.txt (Escape closed the wizard instead of Help) before this was
     added. This never fires from a real click on the menu button itself,
     since that button sits under the wizard's own backdrop and a real
     mouse click cannot reach it — only automated `.click()` calls (or a
     keyboard user tabbing to it) can, which is exactly the case worth
     covering. */
  (function wireOnboardingFileMenu() {
    var menu = document.getElementById("file-menu");
    if (!menu) return;
    menu.addEventListener("click", function (e) {
      var item = e.target.closest("[data-file-action]");
      if (!item) return;
      var modal = onboardModal();
      if (modal && !modal.hidden) closeOnboarding();
      if (item.getAttribute("data-file-action") !== "setup") return;
      e.stopPropagation();
      if (typeof toggleFileMenu === "function") toggleFileMenu(false);
      openOnboarding();
    }, true);
  })();

  /* ---- deciding whether to show it on its own, at boot ----

     Eligible only when ALL of:
       - the pristine-seed gate passes (invariant #30);
       - the key has never been written (Skip and Finish both write it);
       - this load has not opened, and is not about to reopen, any project:
         a hosted document (serverDoc.id), a file already adopted this load
         (docFileHandle.kind — set the moment openProjectFile()/
         adoptProjectState() runs, in 18-local-files.js), or a remembered
         file handle in IndexedDB that tryResumeLastProject() (21-events.js)
         is either about to reopen outright or about to offer to reopen via
         the resume banner. That last check is deliberately broad: a
         remembered handle existing at all means this browser already has a
         project it cares about, whether or not permission has to be
         re-granted with a click first — showing the wizard over either
         outcome is exactly the "must not appear over a document that's
         about to reopen" case this gate exists for. */
  async function onboardEligibleForAutoShow() {
    if (!seedCheckPasses()) return false;
    if (readOnboardKey()) return false;
    /* A tab restoring a crash draft looks exactly like a first run from here:
       the page IS the untouched seed until the draft is applied, which happens
       after the boot load (21-events.js). Putting the welcome wizard over
       somebody's recovered work would be the worst possible first thing to do
       with it. draftRestorePending (20g-drafts.js) is DESKTOP.hasDraftToRestore
       — which the desktop launch-intent gate names as well — so this line is
       belt to that gate's braces, and is what covers it while the gate below
       is still the older last-file one. */
    if (DESKTOP && draftRestorePending) return false;
    if (typeof serverDoc !== "undefined" && serverDoc && serverDoc.id) return false;
    if (typeof docFileHandle !== "undefined" && docFileHandle && docFileHandle.kind) return false;
    /* The browser's "a remembered handle exists at all" check reads
       IndexedDB, which desktop never writes to (00-prelude.js's
       rememberLastFileHandle routes through DESKTOP.setLastFile() instead)
       — so on desktop this has to ask the main process for the same fact,
       or a copy that opens straight back into last night's script would
       show the wizard over it regardless. */
    if (DESKTOP) {
      var lastEntry = null;
      try { lastEntry = await DESKTOP.getLastFile(); } catch (e) { lastEntry = null; }
      if (lastEntry) return false;
    } else {
      var handle = null;
      try { handle = await loadLastFileHandle(); } catch (e) { handle = null; }
      if (handle) return false;
    }
    /* Re-check what may have changed while the round trip above was in
       flight (a file could have finished opening, or Skip/Finish could have
       already run from a very fast manual File ▸ Setup…). */
    if (readOnboardKey()) return false;
    if (typeof serverDoc !== "undefined" && serverDoc && serverDoc.id) return false;
    if (typeof docFileHandle !== "undefined" && docFileHandle && docFileHandle.kind) return false;
    return true;
  }

  async function maybeAutoShowOnboarding() {
    var eligible = false;
    try { eligible = await onboardEligibleForAutoShow(); } catch (e) { eligible = false; }
    if (eligible) openOnboarding({ auto: true });
  }

  maybeAutoShowOnboarding();

  /* ---- test hook ----
     The wizard's own gate is what a headless test needs to drive directly —
     there is no file picker to fake here, but there is a checksum to poke
     at without waiting out a real reload. Nothing in the app reads this;
     the same trick window.__splitpageFormats (20d-formats.js) plays. */
  window.__onboarding = {
    open: openOnboarding,
    close: closeOnboarding,
    seedCheckPasses: seedCheckPasses,
    readKey: readOnboardKey,
    /* → Promise<boolean>. WHY exposed: T3 (26-desktop-drafts.txt) needs to
       prove the wizard's gate itself — not just draftRestorePending's raw
       value — refuses to fire while a crash draft is still restoring
       (DRAFT-RENDERER-API), the same "must not appear over a document
       that's about to reopen" rule this gate exists for. Nothing in src/js
       calls this. */
    eligible: onboardEligibleForAutoShow
  };
