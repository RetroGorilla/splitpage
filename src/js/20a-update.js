  /* ================= updates =================

     This page never talks to an update server and never writes a file. It
     reads a verdict somebody else reached and, when the user clicks, asks
     that somebody else to act on it. There are two of them:

       - the desktop app: the main process checks at launch and pushes its
         status over the bridge; Download and Install are bridge calls that
         take no arguments (main knows the URL and the path — the page never
         names either). See main.js section 9.

       - the launcher (start.mjs): it writes update-status.json next to the
         app before it serves anything, and rewrites it once its background
         check answers. Download is POST api/launcher/update/stage, which is
         loopback-only and launch-token-gated, and which only ever DOWNLOADS
         — the files are swapped by start.mjs at the next launch, when no
         browser has the app open. That split is deliberate: this page is
         served by a localhost server with no authentication, so a route that
         replaced app files on request could be driven by any other page the
         browser has open.

     Absent file, file:// open, or a hosted deployment: the fetch fails or
     404s, nothing is shown, and the app behaves exactly as it did before.

     WHY IT POLLS. The check is a network round trip started at launch, and
     this page routinely finishes loading before it answers. Reading the
     status once therefore showed a launch's own verdict only on the NEXT
     launch. `checking` says the answer is still coming, so the page waits
     for it; the desktop app pushes instead, which needs no polling at all. */

  var updateStatus = null;
  /* Text that replaces the computed line: download progress, or why an
     attempt failed. Cleared whenever a fresh status supersedes it. */
  var updateNotice = null;
  /* An action is in flight — the button stays out until it settles, so one
     click cannot start two downloads. */
  var updateBusy = false;
  /* Dismiss means dismiss: a status arriving later must not put the bar back
     up on someone who closed it. Reset only by an action they took. */
  var updateDismissed = false;

  var UPDATE_POLL_MS = 1500;
  var UPDATE_POLL_LIMIT = 20;   /* ~30s, then stop asking */
  var updatePolls = 0;
  var updatePollTimer = null;

  function loadUpdateStatus() {
    /* The desktop app has no update-status.json to read and no launcher to
       ask: the bridge is the whole channel, and it pushes. */
    if (DESKTOP && DESKTOP.getUpdateStatus) {
      if (DESKTOP.onUpdateStatus) DESKTOP.onUpdateStatus(applyUpdateStatus);
      DESKTOP.getUpdateStatus().then(applyUpdateStatus).catch(function () {});
      return;
    }
    fetchUpdateStatus();
  }

  function fetchUpdateStatus() {
    /* no-store: the whole point is to see what the launcher wrote THIS run */
    fetch("update-status.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        if (!body || typeof body !== "object") return;
        applyUpdateStatus(body);
        if (body.checking) pollUpdateStatus();
      })
      .catch(function () { /* not launched by start.mjs — nothing to say */ });
  }

  function pollUpdateStatus() {
    if (updatePollTimer) return;
    if (updatePolls >= UPDATE_POLL_LIMIT) return;
    updatePolls++;
    updatePollTimer = setTimeout(function () {
      updatePollTimer = null;
      fetchUpdateStatus();
    }, UPDATE_POLL_MS);
  }

  function applyUpdateStatus(status) {
    if (!status || typeof status !== "object") return;
    updateStatus = status;
    /* A status that has moved on is the authority, not the last thing this
       page said about it — except while an action of ours is mid-flight,
       whose progress line IS the current truth. */
    if (!updateBusy) updateNotice = null;
    renderUpdateNotice();
  }

  /* Only ever the app's own launcher routes, and only when this copy was
     started by one (hasLauncher()). A hosted deployment and a file:// open
     both answer no, and no button is offered. */
  function canStageFromLauncher() {
    return !DESKTOP && typeof hasLauncher === "function" && hasLauncher();
  }

  function formatBytes(n) {
    if (!n || n < 0) return "";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function downloadProgressText(dl) {
    var total = dl.total || 0;
    var got = dl.received || 0;
    if (total > 0) {
      return "Downloading Splitpage " + (updateStatus.latest || "") + "\u2026 " +
        Math.min(100, Math.round((got / total) * 100)) + "%" +
        " (" + formatBytes(got) + " of " + formatBytes(total) + ")";
    }
    return "Downloading Splitpage " + (updateStatus.latest || "") + "\u2026 " + formatBytes(got);
  }

  /* ---- the two actions ---- */

  /* Desktop: fetch the installer for this machine, in-app. */
  function startDesktopDownload() {
    if (updateBusy) return;
    updateBusy = true;
    updateNotice = null;
    renderUpdateNotice();
    DESKTOP.downloadUpdate().then(function (result) {
      updateBusy = false;
      if (result && result.ok) {
        /* The push from main already carries state "ready"; nothing to say
           here that renderUpdateNotice will not say better. */
        updateNotice = null;
      } else {
        updateNotice = "Could not download the update" +
          (result && result.message ? ": " + result.message : ".");
      }
      renderUpdateNotice();
    }).catch(function (err) {
      updateBusy = false;
      updateNotice = "Could not download the update: " + (err && err.message ? err.message : "unknown error");
      renderUpdateNotice();
    });
  }

  /* Desktop: run what was downloaded. The app quits as the installer starts,
     so there is nothing to render afterwards. */
  function startDesktopInstall() {
    if (updateBusy) return;
    updateBusy = true;
    updateNotice = "Starting the installer\u2026";
    renderUpdateNotice();
    DESKTOP.installUpdate().then(function (result) {
      if (result && result.ok) return; /* the app is on its way out */
      updateBusy = false;
      if (result && result.error === "quit-cancelled") {
        /* The install needs the app to close, and something stopped it from
           closing — unsaved work, or the stop-sharing prompt. Nothing was
           started; the button below is back, for whenever they are ready. */
        updateNotice = "Splitpage has to close to install the update, and it was kept open. " +
          "The download is still here — try again when you are ready.";
      } else if (result && result.error === "not-downloaded") {
        updateNotice = "The download is no longer there. Download it again.";
      } else {
        updateNotice = "Could not start the installer" +
          (result && result.message ? ": " + result.message : ".");
      }
      renderUpdateNotice();
    }).catch(function (err) {
      updateBusy = false;
      updateNotice = "Could not start the installer: " + (err && err.message ? err.message : "unknown error");
      renderUpdateNotice();
    });
  }

  /* Launcher: download and verify the release into .update/. It installs on
     the next launch — never over an app the browser has open. */
  function startLauncherStage() {
    if (updateBusy) return;
    updateBusy = true;
    updateNotice = "Downloading Splitpage " + (updateStatus.latest || "") + "\u2026";
    renderUpdateNotice();
    launcherFetch("api/launcher/update/stage", { method: "POST" }).then(function (result) {
      updateBusy = false;
      updateNotice = null;
      if (result && result.staged) {
        /* Reflect it locally: update-status.json is only rewritten at launch,
           so the file would still say "available" until the next one. */
        updateStatus = Object.assign({}, updateStatus, {
          pending: result.pending || { to: result.latest || updateStatus.latest }
        });
      } else if (result && result.error === "local-edits") {
        updateNotice = "Some app files have been edited by hand, and the update would " +
          "overwrite them, so nothing was downloaded. Move them aside, then try again.";
      } else if (result && result.ok) {
        updateNotice = "Splitpage is already up to date.";
      } else {
        updateNotice = "Could not download the update" +
          (result && result.message ? ": " + result.message : ".");
      }
      renderUpdateNotice();
    }).catch(function (err) {
      updateBusy = false;
      if (err && err.code === "no-launcher") {
        updateNotice = "This copy was not started by the launcher, so it cannot update itself.";
      } else {
        updateNotice = "Could not download the update" +
          (err && err.message ? ": " + err.message : ".");
      }
      renderUpdateNotice();
    });
  }

  /* What the bar should say and offer, as data — one decision, made once,
     rather than a text assignment per branch that has to remember to set or
     clear the button every time. {text, action, label} or null for "nothing
     to show". */
  function updateBarPlan() {
    if (!updateStatus) return null;
    var version = updateStatus.version || "?";

    if (DESKTOP && updateStatus.desktop) {
      var dl = updateStatus.download || { state: "idle" };
      /* Downloaded and verified: one click from installing. */
      if (dl.state === "ready") {
        return {
          text: "Splitpage " + (updateStatus.latest || "") + " is downloaded and ready to install.",
          action: startDesktopInstall,
          label: "Install and restart"
        };
      }
      if (dl.state === "downloading") {
        return { text: downloadProgressText(dl), action: null, label: null };
      }
      if (!updateStatus.updateAvailable || !updateStatus.latest) return null;

      var available = "Splitpage " + updateStatus.latest + " is available. You have " + version + ".";
      if (dl.state === "failed") {
        return {
          text: available + " The download did not finish" + (dl.error ? " (" + dl.error + ")" : "") + ".",
          action: startDesktopDownload,
          label: "Try again"
        };
      }
      /* A release with no installer for this platform and architecture is the
         one case left where the release page is the best this can do. */
      if (!updateStatus.canInstall) {
        return {
          text: available,
          action: function () { DESKTOP.openExternal(updateStatus.releaseUrl); },
          label: "Open release page"
        };
      }
      return { text: available, action: startDesktopDownload, label: "Download" };
    }

    /* Staged and waiting beats merely available: it is one restart away and
       needs nothing from the user but closing the window. */
    if (updateStatus.pending) {
      return {
        text: "Splitpage " + updateStatus.pending.to + " is ready — restart to finish installing it.",
        action: null,
        label: null
      };
    }
    if (!updateStatus.updateAvailable || !updateStatus.latest) return null;

    var line = "Splitpage " + updateStatus.latest + " is available. You have " + version + ".";
    /* With a launcher, this is one click: it downloads and verifies now, and
       start.mjs swaps the files in at the next launch. Without one there is
       nothing this page can do but say so. */
    if (canStageFromLauncher()) {
      return { text: line, action: startLauncherStage, label: "Download" };
    }
    return { text: line, action: null, label: null };
  }

  function renderUpdateNotice() {
    var bar = document.getElementById("update-bar");
    var actionBtn = document.getElementById("update-bar-action");
    var textEl = document.getElementById("update-bar-text");
    if (!bar || !textEl) return;

    var plan = updateBarPlan();
    /* An in-flight action's own message keeps the bar up even when the plan
       says there is nothing to show — that is how "already up to date" and a
       failure reason get seen at all. */
    if (!plan && !updateNotice) {
      if (actionBtn) actionBtn.hidden = true;
      bar.hidden = true;
      return;
    }
    if (updateDismissed) return;

    textEl.textContent = updateNotice || plan.text;
    if (actionBtn) {
      /* No button while one of our own actions is in flight: a second click
         must not start a second download. */
      var action = !updateBusy && plan ? plan.action : null;
      if (action) {
        actionBtn.hidden = false;
        actionBtn.textContent = plan.label;
        actionBtn.onclick = action;
      } else {
        actionBtn.hidden = true;
        actionBtn.onclick = null;
      }
    }
    bar.hidden = false;
  }

  function dismissUpdateNotice() {
    var bar = document.getElementById("update-bar");
    if (bar) bar.hidden = true;
    /* Stay dismissed: the desktop app pushes status changes and the launcher
       copy polls, so without this the bar would reappear on the next one. */
    updateDismissed = true;
    if (updatePollTimer) { clearTimeout(updatePollTimer); updatePollTimer = null; }
  }

  /* ================= desktop app notice =================

     A separate, always-available notice pointing browser users at the
     desktop app — distinct from #update-bar, which only ever appears when
     there IS an update (nothing to show the rest of the time, which is
     exactly the population this notice targets). Unlike the update bar it
     needs no launcher and no update-status.json, so it must not live inside
     loadUpdateStatus()'s fetch chain: it has to show on a plain file://
     open and wherever that file 404s. */

  var DESKTOP_APP_RELEASES_URL = "https://github.com/RetroGorilla/splitpage-releases/releases/latest";
  var DESKTOP_NOTICE_KEY = "splitpage-desktop-notice-dismissed";

  function renderDesktopAppNotice() {
    /* Already in the desktop app — nothing to point it at. */
    if (DESKTOP) return;
    try {
      if (localStorage.getItem(DESKTOP_NOTICE_KEY) === "1") return;
    } catch (e) { /* no storage — fall through and show it */ }

    var bar = document.getElementById("desktop-app-bar");
    if (!bar) return;
    var textEl = document.getElementById("desktop-app-bar-text");
    if (textEl) {
      textEl.textContent = "The Splitpage desktop app is available — its own window, " +
        "and a version history that never runs out of browser storage.";
    }
    var url = (updateStatus && updateStatus.desktopAppUrl) || DESKTOP_APP_RELEASES_URL;
    var actionBtn = document.getElementById("desktop-app-bar-action");
    if (actionBtn) {
      actionBtn.onclick = function () { window.open(url, "_blank", "noopener"); };
    }
    bar.hidden = false;
  }

  function dismissDesktopAppNotice() {
    var bar = document.getElementById("desktop-app-bar");
    if (bar) bar.hidden = true;
    try { localStorage.setItem(DESKTOP_NOTICE_KEY, "1"); } catch (e) {}
  }

  function showAbout() {
    var lines = [];
    var version = (updateStatus && updateStatus.version) || readEmbeddedVersion();
    lines.push("Splitpage " + (version || "(version unknown)"));

    if (DESKTOP) {
      lines.push("");
      var dl = (updateStatus && updateStatus.download) || { state: "idle" };
      if (!updateStatus) {
        lines.push("Could not check for updates.");
      } else if (updateStatus.checking) {
        lines.push("Checking for updates\u2026");
      } else if (dl.state === "ready") {
        lines.push("Version " + (updateStatus.latest || "") + " is downloaded and verified.");
        lines.push("Use Install and restart in the update notice to finish.");
      } else if (dl.state === "downloading") {
        lines.push("Downloading version " + (updateStatus.latest || "") + "\u2026");
      } else if (updateStatus.updateAvailable && updateStatus.latest) {
        lines.push("Version " + updateStatus.latest + " is available.");
        lines.push(updateStatus.canInstall
          ? "Use the Download button in the update notice — it installs from inside the app."
          : "There is no installer for this platform in that release. Get it from " +
            (updateStatus.releaseUrl || "the release page") + ".");
      } else if (updateStatus.error) {
        lines.push("Last update check failed: " + updateStatus.error);
      } else {
        lines.push("Up to date.");
      }
      window.alert(lines.join("\n"));
      return;
    }

    if (!updateStatus) {
      lines.push("");
      lines.push("Opened without the launcher, so updates cannot be checked from here.");
      lines.push("Start it with start.bat (Windows) or ./start.sh, or run:");
      lines.push("    node update.mjs check");
    } else if (updateStatus.pending) {
      lines.push("");
      lines.push("Version " + updateStatus.pending.to + " is downloaded and verified.");
      lines.push("Close this window and start Splitpage again to install it.");
    } else if (updateStatus.checking) {
      lines.push("");
      lines.push("Checking for updates\u2026");
    } else if (updateStatus.updateAvailable) {
      lines.push("");
      lines.push("Version " + updateStatus.latest + " is available.");
      lines.push(canStageFromLauncher()
        ? "Use the Download button in the update notice, then restart Splitpage."
        : "Run  node update.mjs  to download it, then restart.");
    } else if (updateStatus.error) {
      lines.push("");
      lines.push("Last update check failed: " + updateStatus.error);
    } else if (updateStatus.latest) {
      lines.push("");
      lines.push("Up to date.");
    }
    window.alert(lines.join("\n"));
  }

  /* ---- test hook ----
     The bar's whole job is to turn a status object into a line of text and a
     button, and that is what a headless test needs to drive: there is no
     launcher to start and no release to publish here. applyStatus feeds it a
     status exactly as the launcher's file or the desktop bridge would, and
     `bar` reads back what the user would see. Nothing in the app reads this;
     the same trick window.__onboarding (20b-onboarding.js) plays. */
  window.__updateTest = {
    /* A fresh case: clears what earlier cases left behind, then applies. */
    applyStatus: function (status) {
      updateDismissed = false;
      updateBusy = false;
      updateNotice = null;
      applyUpdateStatus(status);
    },
    /* The same status arriving the way a real one does — the launcher's poll
       or the desktop app's push — with nothing reset first. This is the one
       that can prove a dismissed bar stays dismissed. */
    pushStatus: applyUpdateStatus,
    bar: function () {
      var bar = document.getElementById("update-bar");
      var btn = document.getElementById("update-bar-action");
      return {
        hidden: !bar || bar.hidden,
        text: (document.getElementById("update-bar-text") || {}).textContent || "",
        buttonHidden: !btn || btn.hidden,
        buttonLabel: btn ? btn.textContent : ""
      };
    },
    /* Press the bar's button, whatever it currently is. Answers whether there
       was one to press — read BEFORE the click, because an action's first act
       is usually to hide it. */
    clickAction: function () {
      var btn = document.getElementById("update-bar-action");
      var pressable = !!(btn && !btn.hidden);
      if (pressable) btn.click();
      return pressable;
    },
    dismiss: dismissUpdateNotice,
    dismissed: function () { return updateDismissed; }
  };

  /* The version the page itself was built as, for the file:// case where
     there is no launcher to ask. */
  function readEmbeddedVersion() {
    var meta = document.querySelector('meta[name="splitpage-version"]');
    return meta ? meta.getAttribute("content") : null;
  }
