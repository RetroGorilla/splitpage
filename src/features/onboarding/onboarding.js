import { escapeHtml } from "../../core/document/text-policy.ts";
import { joinErrorText } from "../../../shared/server-links.js";

var ports = null;
var listeners = [];
var activeMount = null;

function listen(target, type, listener) {
  target.addEventListener(type, listener);
  listeners.push(function () { target.removeEventListener(type, listener); });
}

var onboardStep = 1;
var onboardReturnFocus = null;
var launcherInfoState = "unloaded";

function onboardModal() { return document.getElementById("onboarding-modal"); }

function resetOnboardUi() {
  onboardStep = 1;
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

export function openOnboarding() {
  var modal = onboardModal();
  if (!modal) return;
  ports.sidePanels.closeAll();
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

function finishOnboarding(skipped) {
  ports.preferences.recordOnboarding(!!skipped, new Date().toISOString());
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
  ports.actions.invoke("tour", "button");
}

function noLauncherHtml() {
  return '<p class="modal-hint">This copy of Splitpage runs wherever its folder is — ' +
    "copy it anywhere and it still works. Splitpage cannot register itself in the " +
    "Start Menu: nothing in this copy installs anything, so there is nothing to " +
    "uninstall either — delete the folder and it is gone.</p>" +
    '<p class="modal-hint">If you want a Start Menu entry, a taskbar icon and updates ' +
    "that install themselves, that is the <strong>desktop app</strong> — a separate " +
    "download from the releases page. To update this copy, unzip a newer release over " +
    "its folder.</p>";
}

function renderLauncherInfoBody(html) {
  var el = document.getElementById("onboard-install-body");
  if (el) el.innerHTML = html;
}

function desktopInstallHtml() {
  return '<p class="modal-hint">Splitpage is already installed as a desktop app — this is it. ' +
    "Opening a <code>.splitpage</code> file (or a Markdown script saved from here) opens it " +
    "with Splitpage automatically.</p>";
}

function renderLauncherInfo(info) {
  renderLauncherInfoBody(
    '<p class="modal-hint">Running from <code>' + escapeHtml(info.root || "") + "</code>. " +
    "This copy runs wherever that folder is — move it, copy it onto a USB stick, " +
    "it still works. Nothing was installed, so there is nothing to uninstall: " +
    "delete the folder and it is gone.</p>" +
    '<p class="modal-hint">To update it, unzip a newer release over that folder — it does ' +
    "not replace its own files. For a Start Menu entry, a taskbar icon and updates that " +
    "install themselves, get the <strong>desktop app</strong> from the releases page.</p>"
  );
}

async function loadLauncherInfo() {
  if (launcherInfoState !== "unloaded") return;
  launcherInfoState = "loading";
  if (ports.desktop()) {
    launcherInfoState = "done";
    renderLauncherInfoBody(desktopInstallHtml());
    return;
  }
  var mounted = activeMount;
  var info;
  try { info = await ports.launcherInfo(); }
  catch (e) { info = null; }
  if (activeMount !== mounted) return;
  launcherInfoState = "done";
  if (onboardStep !== 2) return;
  if (!info) renderLauncherInfoBody(noLauncherHtml());
  else renderLauncherInfo(info);
}

function selectOnboardWork(kind) {
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

async function copyOnboardHostCmd() {
  var text = onboardHostCommandText();
  try {
    await navigator.clipboard.writeText(text);
    if (typeof ports.notices.show === "function") ports.notices.show("Command copied.", "ok");
    return;
  } catch (e) { }
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
    if (typeof ports.notices.show === "function") ports.notices.show("Command copied.", "ok");
  } catch (err) {
    if (typeof ports.notices.show === "function") ports.notices.show("Could not copy — select the command and copy it by hand.", "warn");
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
  ports.fileDelivery.deliver("splitpage-host.cmd", lines.join("\r\n") + "\r\n", { savedMsg: "Saved the host command." });
}

function setJoinError(message) {
  var el = document.getElementById("onboard-join-error");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

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
    result = await ports.addServerBookmark(name, url, { pin: pin, remember: remember });
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
  }
  if (!result.ok) {
    setJoinError(typeof joinErrorText === "function" ? joinErrorText(result.error) : ("Could not join: " + result.error));
    return;
  }
  if (typeof ports.notices.show === "function") {
    ports.notices.show("Joined" + (result.bookmark ? " " + result.bookmark.name : "") + ".", "ok");
  }
  onboardStep = 4;
  renderOnboardStep();
}

async function onboardEligibleForAutoShow() {
  if (!ports.seedCheck.passes()) return false;
  if (ports.preferences.onboarding()) return false;
  if (ports.place.arrivingOnLink()) return false;
  if (ports.desktop() && ports.draftResume.restorePending()) return false;
  if (ports.place.home().kind === "server" || ports.place.home().kind === "file") return false;
  if (ports.desktop()) {
    if (!ports.launchFacts.firstTabOfLaunch() || ports.launchFacts.hadPriorSession() ||
        (ports.launchFacts.launchIntent() && ports.launchFacts.launchIntent().type !== "blank") ||
        ports.launchFacts.hasDraftToRestore()) return false;
  } else {
    var handle;
    try { handle = await ports.lastFile.load(); } catch (e) { handle = null; }
    if (handle) return false;
  }
  if (ports.preferences.onboarding()) return false;
  if (ports.place.home().kind === "server" || ports.place.home().kind === "file") return false;
  return true;
}

async function maybeAutoShowOnboarding() {
  var mounted = activeMount;
  var eligible;
  try { eligible = await onboardEligibleForAutoShow(); } catch (e) { eligible = false; }
  if (eligible && activeMount === mounted) openOnboarding();
}

export function __init(given) {
  ports = given;
  var mounted = {};
  activeMount = mounted;

  (function wireOnboardingModal() {
    var modal = onboardModal();
    if (!modal) return;

    listen(modal, "click", function (e) {
      var action = e.target.closest("[data-onboard-action]");
      if (action) {
        var name = action.getAttribute("data-onboard-action");
        if (name === "skip") onboardSkip();
        else if (name === "back") onboardBack();
        else if (name === "next") onboardNext();
        else if (name === "host-copy") copyOnboardHostCmd();
        else if (name === "host-save") saveOnboardHostCmd();
        else if (name === "join-submit") submitOnboardJoin();
        else if (name === "finish-tour") onboardFinishAndTour();
        else if (name === "open-servers") { e.preventDefault(); closeOnboarding(); ports.actions.invoke("servers", "button"); }
        else if (name === "open-help") { e.preventDefault(); closeOnboarding(); ports.actions.invoke("help", "button"); }
        return;
      }
      var card = e.target.closest("[data-onboard-work]");
      if (card) { selectOnboardWork(card.getAttribute("data-onboard-work")); return; }
      if (e.target === modal) onboardSkip();
    });

    listen(modal, "keydown", function (e) {
      if (e.key !== "Enter") return;
      var joinPanel = document.getElementById("onboard-join-panel");
      if (joinPanel && !joinPanel.hidden && joinPanel.contains(e.target)) {
        e.preventDefault();
        submitOnboardJoin();
      }
    });

    listen(window, "keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) { e.preventDefault(); onboardSkip(); }
    });

    listen(modal, "keydown", function (e) {
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

  listeners.push(ports.onFileMenuChoice(function () { closeOnboarding(); }));

  var autoShowDecided = maybeAutoShowOnboarding();

  window.__onboarding = {
    seedCheckPasses: function () { return ports.seedCheck.passes(); },
    eligible: onboardEligibleForAutoShow,
    autoShowDecided: function () { return autoShowDecided; }
  };
  var probe = window.__onboarding;
  var disposed = false;
  return {
    openOnboarding: function () { if (!disposed) openOnboarding(); },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      while (listeners.length) listeners.pop()();
      closeOnboarding();
      if (window.__onboarding === probe) delete window.__onboarding;
      activeMount = null;
      ports = null;
    }
  };
}
