import { S } from "./_state.js";
import { arrivingOnLink } from "./13-hosted.js";

var updateStatus = null;
var updateNotice = null;
var updateBusy = false;
// Only user action resets; late statuses must not reshow bar
var updateDismissed = false;

var UPDATE_POLL_MS = 1500;
var UPDATE_POLL_LIMIT = 20;
var updatePolls = 0;
var updatePollTimer = null;

export function loadUpdateStatus() {
  if (S.DESKTOP && S.DESKTOP.getUpdateStatus) {
    if (S.DESKTOP.onUpdateStatus) S.DESKTOP.onUpdateStatus(applyUpdateStatus);
    S.DESKTOP.getUpdateStatus().then(applyUpdateStatus).catch(function () {});
    return;
  }
  fetchUpdateStatus();
}

function fetchUpdateStatus() {
  // no-store: must see what launcher wrote this run
  fetch("update-status.json", { cache: "no-store" })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (body) {
      if (!body || typeof body !== "object") return;
      applyUpdateStatus(body);
      if (body.checking) pollUpdateStatus();
    })
    .catch(function () { });
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
  // In-flight action's progress line overrides incoming status
  if (!updateBusy) updateNotice = null;
  renderUpdateNotice();
}

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

function startDesktopDownload() {
  if (updateBusy) return;
  updateBusy = true;
  updateNotice = null;
  renderUpdateNotice();
  S.DESKTOP.downloadUpdate().then(function (result) {
    updateBusy = false;
    if (result && result.ok) {
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

function startDesktopInstall() {
  if (updateBusy) return;
  updateBusy = true;
  updateNotice = "Starting the installer\u2026";
  renderUpdateNotice();
  S.DESKTOP.installUpdate().then(function (result) {
    if (result && result.ok) return;
    updateBusy = false;
    if (result && result.error === "quit-cancelled") {
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

function openReleasesPage() {
  var url = releasesUrl();
  if (S.DESKTOP && S.DESKTOP.openExternal) { S.DESKTOP.openExternal(url); return; }
  window.open(url, "_blank", "noopener");
}

function updateBarPlan() {
  if (!updateStatus) return null;
  var version = updateStatus.version || "?";

  if (S.DESKTOP && updateStatus.desktop) {
    var dl = updateStatus.download || { state: "idle" };
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
  // In-flight message keeps bar up, e.g. failures
  if (!plan && !updateNotice) {
    if (actionBtn) actionBtn.hidden = true;
    bar.hidden = true;
    return;
  }
  if (updateDismissed) return;

  textEl.textContent = updateNotice || plan.text;
  if (actionBtn) {
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
  // Stay dismissed: pushes and polling would otherwise reshow bar
  updateDismissed = true;
  if (updatePollTimer) { clearTimeout(updatePollTimer); updatePollTimer = null; }
}

var DESKTOP_NOTICE_KEY = "splitpage-desktop-notice-dismissed";

// Installer is Windows-only; phones, Mac, Linux get nothing
export function desktopAppOffered() {
  if (S.DESKTOP) return false;
  if (typeof arrivingOnLink === "function" && arrivingOnLink()) return false;
  var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  return /Windows/.test(ua) && !/Mobi|Android/.test(ua);
}

export function renderDesktopAppNotice() {
  if (!desktopAppOffered()) return;
  try {
    if (localStorage.getItem(DESKTOP_NOTICE_KEY) === "1") return;
  } catch (e) { }

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

export function readEmbeddedVersion() {
  var meta = document.querySelector('meta[name="splitpage-version"]');
  return meta ? meta.getAttribute("content") : null;
}

export function __init() {
  window.__updateTest = {
    applyStatus: function (status) {
      updateDismissed = false;
      updateBusy = false;
      updateNotice = null;
      applyUpdateStatus(status);
    },
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
