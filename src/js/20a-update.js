import { S } from "./_state.js";
import { arrivingOnLink } from "./13-hosted.js";

/* ================= updates =================

   This page never talks to an update server and never writes a file. It
   reads a verdict somebody else reached and says what it means. There are
   two of them, and only one of them can act on it:

     - the desktop app: the main process checks at launch and pushes its
       status over the bridge; Download and Install are bridge calls that
       take no arguments (main knows the URL and the path — the page never
       names either). See main.js section 9.

     - the launcher (start.mjs): it writes update-status.json next to the
       app before it serves anything, and rewrites it once its background
       check answers. That file is the whole channel — the launcher CHECKS
       and nothing more. It used to stage a release through POST
       api/launcher/update/stage and swap the files in at the next launch.
       #75 deleted the staging half of update.mjs; the route and this
       bar's Download button went with it, and with them the only way this
       copy could install anything. So the portable bar is a signpost now:
       here is a newer version, here is the page it is on, and unzipping
       it over the folder is the user's move to make.

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

export function loadUpdateStatus() {
  /* The desktop app has no update-status.json to read and no launcher to
     ask: the bridge is the whole channel, and it pushes. */
  if (S.DESKTOP && S.DESKTOP.getUpdateStatus) {
    if (S.DESKTOP.onUpdateStatus) S.DESKTOP.onUpdateStatus(applyUpdateStatus);
    S.DESKTOP.getUpdateStatus().then(applyUpdateStatus).catch(function () {});
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

/* Where a newer version actually is. The launcher's status file names no
   URL of its own — only the desktop app's bridge does (releaseUrl) — so
   this constant is the fallback, and it is the same page the desktop-app
   notice at the bottom of this file points at. */
var RELEASES_URL = "https://github.com/RetroGorilla/splitpage-releases/releases/latest";

function releasesUrl() {
  return (updateStatus && (updateStatus.releaseUrl || updateStatus.desktopAppUrl)) || RELEASES_URL;
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

/* ---- the actions ---- */

/* Desktop: fetch the installer for this machine, in-app. */
function startDesktopDownload() {
  if (updateBusy) return;
  updateBusy = true;
  updateNotice = null;
  renderUpdateNotice();
  S.DESKTOP.downloadUpdate().then(function (result) {
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
  S.DESKTOP.installUpdate().then(function (result) {
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

/* Portable copy: there is nothing to press but a link. Opening the release
   page is the whole action — no fetch, no route, no file touched. In the
   desktop app (which reaches here only if its status somehow lacks
   `desktop`) the link still goes through main, because a renderer never
   hands a URL to the OS itself. */
function openReleasesPage() {
  var url = releasesUrl();
  if (S.DESKTOP && S.DESKTOP.openExternal) { S.DESKTOP.openExternal(url); return; }
  window.open(url, "_blank", "noopener");
}

/* What the bar should say and offer, as data — one decision, made once,
   rather than a text assignment per branch that has to remember to set or
   clear the button every time. {text, action, label} or null for "nothing
   to show". */
function updateBarPlan() {
  if (!updateStatus) return null;
  var version = updateStatus.version || "?";

  if (S.DESKTOP && updateStatus.desktop) {
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
        action: function () { S.DESKTOP.openExternal(updateStatus.releaseUrl); },
        label: "Open release page"
      };
    }
    return { text: available, action: startDesktopDownload, label: "Download" };
  }

  if (!updateStatus.updateAvailable || !updateStatus.latest) return null;

  /* The portable copy cannot install this — it is updated by unzipping a
     newer release over its folder — so the bar says where the release is
     and what to do with it, and the button goes there. A button that
     started a download it could not finish would be the lie this replaced. */
  return {
    text: "Splitpage " + updateStatus.latest + " is available. You have " + version +
      ". Unzip the new release over this folder to update.",
    action: openReleasesPage,
    label: "Open release page"
  };
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

export function dismissUpdateNotice() {
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

var DESKTOP_NOTICE_KEY = "splitpage-desktop-notice-dismissed";

/* The desktop app is a Windows installer. Offering it to a phone, a Mac or a
   Linux box is a dead end, so the notice and the start screen's footer line
   both ask this first. */
export function desktopAppOffered() {
  /* Already in the desktop app — nothing to point it at. */
  if (S.DESKTOP) return false;
  if (typeof arrivingOnLink === "function" && arrivingOnLink()) return false;
  var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  return /Windows/.test(ua) && !/Mobi|Android/.test(ua);
}

export function renderDesktopAppNotice() {
  if (!desktopAppOffered()) return;
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
  var url = desktopAppUrl();
  var actionBtn = document.getElementById("desktop-app-bar-action");
  if (actionBtn) {
    actionBtn.onclick = function () { window.open(url, "_blank", "noopener"); };
  }
  bar.hidden = false;
}

/* Where "get the desktop app" goes — this notice's button, and the New Tab
   page's footer link (20j-newtab.js), which is the same pitch in the one
   place a new browser visitor is sure to look. */
export function desktopAppUrl() {
  return (updateStatus && updateStatus.desktopAppUrl) || RELEASES_URL;
}

export function dismissDesktopAppNotice() {
  var bar = document.getElementById("desktop-app-bar");
  if (bar) bar.hidden = true;
  try { localStorage.setItem(DESKTOP_NOTICE_KEY, "1"); } catch (e) {}
}

export function showAbout() {
  var lines = [];
  var version = (updateStatus && updateStatus.version) || readEmbeddedVersion();
  var link = null;

  if (S.DESKTOP) {
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
      if (updateStatus.canInstall) {
        lines.push("Use the Download button in the update notice — it installs from inside the app.");
      } else {
        lines.push("There is no installer for this platform in that release.");
        link = updateStatus.releaseUrl || RELEASES_URL;
      }
    } else if (updateStatus.error) {
      lines.push("Last update check failed: " + updateStatus.error);
    } else {
      lines.push("Up to date.");
    }
  } else if (!updateStatus) {
    lines.push("This copy was opened without the launcher, so it cannot check for updates.");
    lines.push("New versions are on the releases page.");
    link = releasesUrl();
  } else if (updateStatus.checking) {
    lines.push("Checking for updates\u2026");
  } else if (updateStatus.updateAvailable) {
    lines.push("Version " + updateStatus.latest + " is available.");
    lines.push("This copy does not update itself: download the new zip and " +
      "unzip it over this folder, then start Splitpage again.");
    link = releasesUrl();
  } else if (updateStatus.error) {
    lines.push("Last update check failed: " + updateStatus.error);
  } else if (updateStatus.latest) {
    lines.push("Up to date.");
  }

  openAboutDialog(version, lines, link);
}

var aboutWired = false;

function closeAboutDialog() {
  var modal = document.getElementById("about-modal");
  if (modal) modal.hidden = true;
}

function openAboutDialog(version, lines, link) {
  var modal = document.getElementById("about-modal");
  if (!modal) return;
  if (!aboutWired) {
    aboutWired = true;
    modal.addEventListener("click", function (e) {
      if (e.target === modal || e.target.closest("[data-about-close]")) closeAboutDialog();
    });
    modal.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); closeAboutDialog(); }
    });
  }
  document.getElementById("about-version").textContent =
    "Version " + (version || "unknown");
  var body = document.getElementById("about-body");
  body.textContent = "";
  lines.forEach(function (line) {
    var p = document.createElement("p");
    p.className = "modal-hint";
    p.textContent = line;
    body.appendChild(p);
  });
  var a = document.getElementById("about-link");
  a.hidden = !link;
  if (link) a.href = link;
  modal.hidden = false;
  var close = modal.querySelector("[data-about-close]");
  if (close) close.focus();
}

/* The version the page itself was built as, for the file:// case where
   there is no launcher to ask. */
export function readEmbeddedVersion() {
  var meta = document.querySelector('meta[name="splitpage-version"]');
  return meta ? meta.getAttribute("content") : null;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
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
}
