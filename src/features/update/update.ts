import type { UpdateFeaturePorts, UpdateMount, UpdateStatus } from "./ports.ts";
import { addListener } from "../common/listeners.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

type UpdateProbe = { applyStatus: (status: UpdateStatus | null) => void; pushStatus: typeof applyUpdateStatus; bar: () => { hidden: boolean | "until-found"; text: string; buttonHidden: boolean | "until-found"; buttonLabel: string | null }; clickAction: () => boolean; dismiss: () => void; dismissed: () => boolean };

let ports: UpdateFeaturePorts = null as unknown as UpdateFeaturePorts;
let activeMount: UpdateMount | null = null;
const aboutListeners: Array<() => void> = [];
const noticeDisposers: Array<() => void> = [];

let updateStatus: UpdateStatus | null = null;
let updateNotice: string | null = null;
let updateBusy = false;
let updateDismissed = false;

const UPDATE_POLL_MS = 1500;
const UPDATE_POLL_LIMIT = 20;
let updatePolls = 0;
let updatePollTimer: ReturnType<typeof setTimeout> | null = null;

let stopUpdateStatus: (() => void) | null = null;

function loadUpdateStatus() {
  if (stopUpdateStatus) stopUpdateStatus();
  let active = true;
  updatePolls = 0;
  function apply(status: UpdateStatus | null) { if (active) applyUpdateStatus(status); }
  function fetchStatus() {
    fetch("update-status.json", { cache: "no-store" })
      .then(function (res) { return active && res.ok ? res.json() : null; })
      .then(function (body: unknown) {
        if (!active || !body || typeof body !== "object") return;
        apply(body as UpdateStatus);
        if (!(body as UpdateStatus).checking || updatePollTimer || updatePolls >= UPDATE_POLL_LIMIT) return;
        updatePolls++;
        updatePollTimer = setTimeout(function () {
          if (!active) return;
          updatePollTimer = null;
          fetchStatus();
        }, UPDATE_POLL_MS);
      }).catch(function () {});
  }
  function dispose() {
    if (!active) return;
    active = false;
    if (updatePollTimer) { clearTimeout(updatePollTimer); updatePollTimer = null; }
    ports.updates.stopStatus();
    const action = document.getElementById("update-bar-action");
    if (action) action.onclick = null;
    stopUpdateStatus = null;
  }
  stopUpdateStatus = dispose;
  if (ports.desktop()) {
    ports.updates.onStatus(apply);
    ports.updates.status().then(apply).catch(function () {});
  } else fetchStatus();
  return dispose;
}

function applyUpdateStatus(status: UpdateStatus | null) {
  if (!status || typeof status !== "object") return;
  updateStatus = status;
  if (!updateBusy) updateNotice = null;
  renderUpdateNotice();
}

const RELEASES_URL = "https://github.com/RetroGorilla/splitpage/releases/latest";

function releasesUrl() {
  return (updateStatus && (updateStatus.releaseUrl || updateStatus.desktopAppUrl)) || RELEASES_URL;
}

function formatBytes(n: number) {
  if (!n || n < 0) return "";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function downloadProgressText(dl: NonNullable<UpdateStatus["download"]>) {
  const total = dl.total || 0;
  const got = dl.received || 0;
  if (total > 0) {
    return "Downloading Splitpage " + ((updateStatus as UpdateStatus).latest || "") + "\u2026 " +
      Math.min(100, Math.round((got / total) * 100)) + "%" +
      " (" + formatBytes(got) + " of " + formatBytes(total) + ")";
  }
  return "Downloading Splitpage " + ((updateStatus as UpdateStatus).latest || "") + "\u2026 " + formatBytes(got);
}

function startDesktopDownload() {
  if (updateBusy) return;
  const mounted = activeMount;
  updateBusy = true;
  updateNotice = null;
  renderUpdateNotice();
  ports.updates.download().then(function (result) {
    if (activeMount !== mounted) return;
    updateBusy = false;
    if (result && result.ok) {
      updateNotice = null;
    } else {
      updateNotice = "Could not download the update" +
        (result && result.message ? ": " + result.message : ".");
    }
    renderUpdateNotice();
  }).catch(function (err) {
    if (activeMount !== mounted) return;
    updateBusy = false;
    updateNotice = "Could not download the update: " + (err && err.message ? err.message : "unknown error");
    renderUpdateNotice();
  });
}

function startDesktopInstall() {
  if (updateBusy) return;
  const mounted = activeMount;
  updateBusy = true;
  updateNotice = "Starting the installer\u2026";
  renderUpdateNotice();
  ports.updates.install().then(function (result) {
    if (activeMount !== mounted) return;
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
    if (activeMount !== mounted) return;
    updateBusy = false;
    updateNotice = "Could not start the installer: " + (err && err.message ? err.message : "unknown error");
    renderUpdateNotice();
  });
}

function openReleasesPage() {
  const url = releasesUrl();
  if (ports.desktop() && ports.externalLinks.available()) { ports.externalLinks.open(url); return; }
  window.open(url as string, "_blank", "noopener");
}

function updateBarPlan() {
  if (!updateStatus) return null;
  const version = updateStatus.version || "?";

  if (ports.desktop() && updateStatus.desktop) {
    const dl = updateStatus.download || { state: "idle" };
    if (dl.state === "ready") {
      return {
        text: "Splitpage " + ((updateStatus as UpdateStatus).latest || "") + " is downloaded and ready to install.",
        action: startDesktopInstall,
        label: "Install and restart"
      };
    }
    if (dl.state === "downloading") {
      return { text: downloadProgressText(dl), action: null, label: null };
    }
    if (!updateStatus.updateAvailable || !updateStatus.latest) return null;

    const available = "Splitpage " + updateStatus.latest + " is available. You have " + version + ".";
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
        action: function () { ports.externalLinks.open((updateStatus as UpdateStatus).releaseUrl); },
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
  const bar = document.getElementById("update-bar");
  const actionBtn = document.getElementById("update-bar-action");
  const textEl = document.getElementById("update-bar-text");
  if (!bar || !textEl) return;

  const plan = updateBarPlan();
  if (!plan && !updateNotice) {
    if (actionBtn) actionBtn.hidden = true;
    bar.hidden = true;
    return;
  }
  if (updateDismissed) return;

  textEl.textContent = updateNotice || (plan as NonNullable<typeof plan>).text;
  if (actionBtn) {
    const action = !updateBusy && plan ? plan.action : null;
    if (action) {
      actionBtn.hidden = false;
      actionBtn.textContent = (plan as NonNullable<typeof plan>).label;
      actionBtn.onclick = action;
    } else {
      actionBtn.hidden = true;
      actionBtn.onclick = null;
    }
  }
  bar.hidden = false;
}

function dismissUpdateNotice() {
  const bar = document.getElementById("update-bar");
  if (bar) bar.hidden = true;
  updateDismissed = true;
  if (updatePollTimer) { clearTimeout(updatePollTimer); updatePollTimer = null; }
}

function desktopAppOffered() {
  if (ports.desktop()) return false;
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  return /Windows/.test(ua) && !/Mobi|Android/.test(ua);
}

function renderDesktopAppNotice() {
  let active = true;
  function dispose() {
    if (!active) return;
    active = false;
    const action = document.getElementById("desktop-app-bar-action");
    if (action) action.onclick = null;
  }
  noticeDisposers.push(dispose);
  if (!desktopAppOffered()) return dispose;
  if (ports.preferences.desktopNoticeDismissed()) return dispose;

  const bar = document.getElementById("desktop-app-bar");
  if (!bar) return dispose;
  const textEl = document.getElementById("desktop-app-bar-text");
  if (textEl) {
    textEl.textContent = "The Splitpage desktop app is available — its own window, " +
      "and a version history that never runs out of browser storage.";
  }
  const url = desktopAppUrl();
  const actionBtn = document.getElementById("desktop-app-bar-action");
  if (actionBtn) {
    actionBtn.onclick = function () { if (active) window.open(url, "_blank", "noopener"); };
  }
  bar.hidden = false;
  return dispose;
}

function desktopAppUrl() {
  return (updateStatus && updateStatus.desktopAppUrl) || RELEASES_URL;
}

function dismissDesktopAppNotice() {
  const bar = document.getElementById("desktop-app-bar");
  if (bar) bar.hidden = true;
  ports.preferences.dismissDesktopNotice();
}

function showAbout() {
  const lines = [];
  const version = (updateStatus && updateStatus.version) || readEmbeddedVersion();
  let link = null;

  if (ports.desktop()) {
    const dl = (updateStatus && updateStatus.download) || { state: "idle" };
    if (!updateStatus) {
      lines.push("Could not check for updates.");
    } else if (updateStatus.checking) {
      lines.push("Checking for updates\u2026");
    } else if (dl.state === "ready") {
      lines.push("Version " + ((updateStatus as UpdateStatus).latest || "") + " is downloaded and verified.");
      lines.push("Use Install and restart in the update notice to finish.");
    } else if (dl.state === "downloading") {
      lines.push("Downloading version " + ((updateStatus as UpdateStatus).latest || "") + "\u2026");
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

let aboutWired = false;

function closeAboutDialog() {
  const modal = document.getElementById("about-modal");
  if (modal) modal.hidden = true;
}

function openAboutDialog(version: string | null, lines: string[], link: unknown) {
  const modal = document.getElementById("about-modal");
  if (!modal) return;
  if (!aboutWired) {
    aboutWired = true;
    aboutListeners.push(addListener(modal, "click", function (e) {
      if (e.target === modal || (e.target as Element).closest("[data-about-close]")) closeAboutDialog();
    }));
    aboutListeners.push(addListener(modal, "keydown", function (e) {
      if (e.key === "Escape") { e.stopPropagation(); closeAboutDialog(); }
    }));
  }
  (document.getElementById("about-version") as HTMLElement).textContent =
    "Version " + (version || "unknown");
  const body = document.getElementById("about-body") as HTMLElement;
  body.textContent = "";
  lines.forEach(function (line) {
    const p = document.createElement("p");
    p.className = "modal-hint";
    p.textContent = line;
    body.appendChild(p);
  });
  const a = document.getElementById("about-link") as HTMLAnchorElement;
  a.hidden = !link;
  if (link) a.href = link as string;
  modal.hidden = false;
  const close = modal.querySelector<HTMLElement>("[data-about-close]");
  if (close) close.focus();
}

function readEmbeddedVersion() {
  const meta = document.querySelector('meta[name="splitpage-version"]');
  return meta ? meta.getAttribute("content") : null;
}

export function mountUpdate(nextPorts: UpdateFeaturePorts): UpdateMount {
  if (activeMount) activeMount.dispose();
  ports = nextPorts;
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__updateTest", (): UpdateProbe => ({
    applyStatus: function (status: UpdateStatus | null) {
      updateDismissed = false;
      updateBusy = false;
      updateNotice = null;
      applyUpdateStatus(status);
    },
    pushStatus: applyUpdateStatus,
    bar: function () {
      const bar = document.getElementById("update-bar");
      const btn = document.getElementById("update-bar-action");
      return {
        hidden: !bar || bar.hidden,
        text: (document.getElementById("update-bar-text") || {}).textContent || "",
        buttonHidden: !btn || btn.hidden,
        buttonLabel: btn ? btn.textContent : ""
      };
    },
    clickAction: function () {
      const btn = document.getElementById("update-bar-action");
      const pressable = !!(btn && !btn.hidden);
      if (pressable) (btn as HTMLElement).click();
      return pressable;
    },
    dismiss: dismissUpdateNotice,
    dismissed: function () { return updateDismissed; }
  }), (withdraw) => { withdrawHook = withdraw; });
  let disposed = false;
  const mounted = {
    loadUpdateStatus,
    dismissUpdateNotice,
    renderDesktopAppNotice,
    dismissDesktopAppNotice,
    desktopAppOffered,
    desktopAppUrl,
    showAbout,
    readEmbeddedVersion,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      if (stopUpdateStatus) stopUpdateStatus();
      while (noticeDisposers.length) (noticeDisposers.pop() as () => void)();
      while (aboutListeners.length) (aboutListeners.pop() as () => void)();
      closeAboutDialog();
      aboutWired = false;
      updateStatus = null;
      updateNotice = null;
      updateBusy = false;
      updateDismissed = false;
      withdrawHook?.();
      activeMount = null;
      ports = null as unknown as UpdateFeaturePorts;
    }
  };
  activeMount = mounted;
  return mounted;
}
