import type { OnboardingMount, OnboardingPorts } from "./ports.ts";
import { addListener } from "../common/listeners.ts";

let ports = null as unknown as OnboardingPorts;
const listeners: Array<() => void> = [];
let activeMount: object | null = null;

let onboardStep = 1;
let onboardReturnFocus: HTMLElement | null = null;

function onboardModal() { return document.getElementById("onboarding-modal"); }

function resetOnboardUi() {
  onboardStep = 1;
}

function updateOnboardNav() {
  const back = document.querySelector<HTMLButtonElement>('#onboarding-modal [data-onboard-action="back"]');
  const next = document.querySelector('#onboarding-modal [data-onboard-action="next"]');
  if (back) back.disabled = onboardStep === 1;
  if (next) next.textContent = onboardStep === 3 ? "Finish" : "Next";
}

function renderOnboardStep() {
  const sections = document.querySelectorAll<HTMLElement>("#onboarding-modal .onboard-step");
  for (let i = 0; i < sections.length; i++) {
    (sections[i] as HTMLElement).hidden = (sections[i] as HTMLElement).getAttribute("data-onboard-step") !== String(onboardStep);
  }
  const dots = document.querySelectorAll("#onboard-steps .onboard-dot");
  for (let j = 0; j < dots.length; j++) {
    const n = j + 1;
    (dots[j] as Element).classList.toggle("is-current", n === onboardStep);
    (dots[j] as Element).classList.toggle("is-done", n < onboardStep);
  }
  updateOnboardNav();
  if (onboardStep === 2) renderInstallInfo();
}

export function openOnboarding() {
  const modal = onboardModal();
  if (!modal) return;
  ports.sidePanels.closeAll();
  onboardReturnFocus = document.activeElement as HTMLElement | null;
  resetOnboardUi();
  modal.hidden = false;
  renderOnboardStep();
  const closeBtn = modal.querySelector<HTMLElement>(".modal-close");
  if (closeBtn) closeBtn.focus();
}

function closeOnboarding() {
  const modal = onboardModal();
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (onboardReturnFocus && typeof onboardReturnFocus.focus === "function") {
    try { onboardReturnFocus.focus(); } catch (e) {}
  }
  onboardReturnFocus = null;
}

function finishOnboarding(skipped: boolean) {
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
  const el = document.getElementById("onboard-install-body");
  if (el) el.innerHTML = ports.desktop() ? desktopInstallHtml() : folderCopyHtml();
}

async function onboardEligibleForAutoShow() {
  if (!ports.seedCheck.passes()) return false;
  if (ports.preferences.onboarding()) return false;
  if (ports.desktop() && ports.draftResume.restorePending()) return false;
  if (ports.place.home().kind === "file") return false;
  if (ports.desktop()) {
    if (!ports.launchFacts.firstTabOfLaunch() || ports.launchFacts.hadPriorSession() ||
        (ports.launchFacts.launchIntent() && (ports.launchFacts.launchIntent() as NonNullable<ReturnType<OnboardingPorts["launchFacts"]["launchIntent"]>>).type !== "blank") ||
        ports.launchFacts.hasDraftToRestore()) return false;
  } else {
    let handle;
    try { handle = await ports.lastFile.load(); } catch (e) { handle = null; }
    if (handle) return false;
  }
  if (ports.preferences.onboarding()) return false;
  if (ports.place.home().kind === "file") return false;
  return true;
}

async function maybeAutoShowOnboarding() {
  const mounted = activeMount;
  let eligible;
  try {
    const ready = ports.startup.ready()?.then(() => true, () => false);
    eligible = await onboardEligibleForAutoShow();
    if (!eligible || activeMount !== mounted) return;
    if (ready && !(await ready)) return;
    if (activeMount !== mounted) return;
    eligible = await onboardEligibleForAutoShow();
  } catch (e) { eligible = false; }
  if (eligible && activeMount === mounted) openOnboarding();
}

export function startOnboarding(given: OnboardingPorts): OnboardingMount {
  ports = given;
  const mounted = {};
  activeMount = mounted;

  (function wireOnboardingModal() {
    const modal = onboardModal();
    if (!modal) return;

    listeners.push(addListener(modal, "click", function (e) {
      const action = (e.target as Element).closest("[data-onboard-action]");
      if (action) {
        const name = action.getAttribute("data-onboard-action");
        if (name === "skip") onboardSkip();
        else if (name === "back") onboardBack();
        else if (name === "next") onboardNext();
        else if (name === "finish-tour") onboardFinishAndTour();
        else if (name === "open-help") { e.preventDefault(); closeOnboarding(); ports.actions.invoke("help", "button"); }
        return;
      }
      if (e.target === modal) onboardSkip();
    }));

    listeners.push(addListener(window, "keydown", function (e) {
      if ((e as KeyboardEvent).key === "Escape" && !(modal as HTMLElement).hidden) { e.preventDefault(); onboardSkip(); }
    }));

    listeners.push(addListener(modal, "keydown", function (e) {
      if ((e as KeyboardEvent).key !== "Tab") return;
      const focusables = Array.prototype.filter.call(
        (modal as HTMLElement).querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        function (el: HTMLElement & { disabled?: boolean }) { return !el.disabled && el.offsetParent !== null; }
      ) as HTMLElement[];
      if (!focusables.length) return;
      const first = focusables[0] as HTMLElement, last = focusables[focusables.length - 1] as HTMLElement;
      if ((e as KeyboardEvent).shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!(e as KeyboardEvent).shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }));
  })();

  listeners.push(ports.onFileMenuChoice(function () { closeOnboarding(); }));

  const autoShowDecided = maybeAutoShowOnboarding();

  (window as Window & { __onboarding?: { seedCheckPasses: () => boolean; eligible: () => Promise<boolean>; autoShowDecided: () => Promise<void> } }).__onboarding = {
    seedCheckPasses: function () { return ports.seedCheck.passes(); },
    eligible: onboardEligibleForAutoShow,
    autoShowDecided: function () { return autoShowDecided; }
  };
  const probe = (window as Window & { __onboarding?: { seedCheckPasses: () => boolean; eligible: () => Promise<boolean>; autoShowDecided: () => Promise<void> } }).__onboarding;
  let disposed = false;
  return {
    openOnboarding: function () { if (!disposed) openOnboarding(); },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      while (listeners.length) (listeners.pop() as () => void)();
      closeOnboarding();
      if ((window as Window & { __onboarding?: { seedCheckPasses: () => boolean; eligible: () => Promise<boolean>; autoShowDecided: () => Promise<void> } }).__onboarding === probe) delete (window as Window & { __onboarding?: { seedCheckPasses: () => boolean; eligible: () => Promise<boolean>; autoShowDecided: () => Promise<void> } }).__onboarding;
      activeMount = null;
      ports = null as unknown as OnboardingPorts;
    }
  };
}
