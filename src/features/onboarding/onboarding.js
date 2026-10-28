var ports = null;
var listeners = [];
var activeMount = null;

function listen(target, type, listener) {
  target.addEventListener(type, listener);
  listeners.push(function () { target.removeEventListener(type, listener); });
}

var onboardStep = 1;
var onboardReturnFocus = null;

function onboardModal() { return document.getElementById("onboarding-modal"); }

function resetOnboardUi() {
  onboardStep = 1;
}

function updateOnboardNav() {
  var back = document.querySelector('#onboarding-modal [data-onboard-action="back"]');
  var next = document.querySelector('#onboarding-modal [data-onboard-action="next"]');
  if (back) back.disabled = onboardStep === 1;
  if (next) next.textContent = onboardStep === 3 ? "Finish" : "Next";
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
  if (onboardStep === 2) renderInstallInfo();
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
  if (onboardStep < 3) { onboardStep++; renderOnboardStep(); return; }
  finishOnboarding(false);
}

function onboardBack() {
  if (onboardStep > 1) { onboardStep--; renderOnboardStep(); }
}

function onboardFinishAndTour() {
  finishOnboarding(false);
  ports.actions.invoke("tour", "button");
}

function folderCopyHtml() {
  return '<p class="modal-hint">This copy of Splitpage runs wherever its folder is — ' +
    "copy it anywhere and it still works. Splitpage cannot register itself in the " +
    "Start Menu: nothing in this copy installs anything, so there is nothing to " +
    "uninstall either — delete the folder and it is gone.</p>" +
    '<p class="modal-hint">If you want a Start Menu entry, a taskbar icon and updates ' +
    "that install themselves, that is the <strong>desktop app</strong> — a separate " +
    "download from the releases page. To update this copy, unzip a newer release over " +
    "its folder.</p>";
}

function desktopInstallHtml() {
  return '<p class="modal-hint">Splitpage is already installed as a desktop app — this is it. ' +
    "Opening a <code>.splitpage</code> file (or a Markdown script saved from here) opens it " +
    "with Splitpage automatically.</p>";
}

function renderInstallInfo() {
  var el = document.getElementById("onboard-install-body");
  if (el) el.innerHTML = ports.desktop() ? desktopInstallHtml() : folderCopyHtml();
}

async function onboardEligibleForAutoShow() {
  if (!ports.seedCheck.passes()) return false;
  if (ports.preferences.onboarding()) return false;
  if (ports.desktop() && ports.draftResume.restorePending()) return false;
  if (ports.place.home().kind === "file") return false;
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
  if (ports.place.home().kind === "file") return false;
  return true;
}

async function maybeAutoShowOnboarding() {
  var mounted = activeMount;
  var eligible;
  try { eligible = await onboardEligibleForAutoShow(); } catch (e) { eligible = false; }
  if (eligible && activeMount === mounted) openOnboarding();
}

export function startOnboarding(given) {
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
        else if (name === "finish-tour") onboardFinishAndTour();
        else if (name === "open-help") { e.preventDefault(); closeOnboarding(); ports.actions.invoke("help", "button"); }
        return;
      }
      if (e.target === modal) onboardSkip();
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
