import { S } from "./_state.js";
import { closeAllSidePanels } from "./03b-side-panels.js";
import { showActionToast, showToast } from "./12-dirty-toast.js";
import { appActions } from "../legacy/app-actions.ts";
import { handTourPauseTo } from "../legacy/tour-pause.ts";

function scrollHelpTo(id) {
  var body = document.getElementById("help-body");
  var target = id && document.getElementById(id);
  if (!body || !target) return;
  var bodyRect = body.getBoundingClientRect();
  var targetRect = target.getBoundingClientRect();
  body.scrollTop += (targetRect.top - bodyRect.top) - 12;
}

var helpReturnFocus = null;

export function openHelp(anchor) {
  var modal = document.getElementById("help-modal");
  if (!modal) return;
  suspendTourForHelp();
  closeAllSidePanels();
  helpReturnFocus = document.activeElement;
  modal.hidden = false;
  if (anchor) scrollHelpTo(anchor);
  else {
    var body = document.getElementById("help-body");
    if (body) body.scrollTop = 0;
  }
  var closeBtn = document.getElementById("help-close");
  if (closeBtn) closeBtn.focus();
}

function closeHelp() {
  var modal = document.getElementById("help-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if (tourSuspendedAt >= 0) {
    helpReturnFocus = null;
    resumeTourAfterHelp();
    return;
  }
  if (helpReturnFocus && typeof helpReturnFocus.focus === "function") {
    try { helpReturnFocus.focus(); } catch (e) {}
  }
  helpReturnFocus = null;
}

function suspendTourForHelp() {
  if (tourStepIndex < 0) return;
  var overlay = document.getElementById("tour-overlay");
  if (!overlay) return;
  tourSuspendedAt = tourStepIndex;
  tourStepIndex = -1;
  overlay.hidden = true;
}

function resumeTourAfterHelp() {
  var at = tourSuspendedAt;
  tourSuspendedAt = -1;
  if (at < 0) return;
  var overlay = document.getElementById("tour-overlay");
  if (!overlay) return;
  tourStepIndex = at;
  overlay.hidden = false;
  renderTourStep();
}

function injectTaggingHelpGuideLink() {
  var body = document.querySelector("#tagging-help .tagging-help-foot") ||
    document.querySelector("#tagging-help .tagging-help-body");
  if (!body || document.getElementById("tagging-help-fullguide")) return;
  var wrap = document.createElement("div");
  wrap.className = "tagging-help-fullguide";
  wrap.id = "tagging-help-fullguide";
  var a = document.createElement("a");
  a.href = "#";
  a.textContent = "Open the full guide";
  a.addEventListener("click", function (e) {
    e.preventDefault();
    openHelp("help-tagging-and-the-production-breakdown");
  });
  wrap.appendChild(a);
  body.appendChild(wrap);
}

export var TOUR_DONE_KEY = "splitpage-tour-done";

var TOUR_STEPS = [
  {
    selector: "#rows .row:first-child",
    title: "Two columns",
    body: "The left column is what the viewer sees. The right is what gets said out loud.",
    slug: "help-tagging-and-the-production-breakdown"
  },
  {
    selector: ".visual-cell .cell-editable",
    title: "Tag shortcuts",
    body: "Type [prop], {location}, ~vfx~ or <gear> in a visual note and the closing character makes the tag.",
    slug: "help-tagging-and-the-production-breakdown",
    showTaggingHelp: true
  },
  {
    selector: "#btn-comments",
    title: "Leave a comment",
    body: "Select some text in the script, then Comment — it stays anchored to that exact phrase.",
    slug: "help-writing-and-planning"
  },
  {
    selector: "#btn-save",
    title: "Save",
    body: "Save writes a Markdown file by default — readable anywhere a document opens.",
    slug: "help-reopening-a-saved-project"
  },
  {
    selector: "#btn-present",
    title: "Present",
    body: "Present opens the teleprompter, with Follow My Voice to scroll it as you read aloud.",
    slug: "help-writing-and-planning"
  }
];

var tourStepIndex = -1;
var tourResizeHandler = null;
var tourTaggingHelpWasHidden = true;
var tourSuspendedAt = -1;
var tourInterruptedAt = -1;
var tourResumeFrom = -1;
var tourPausedToast = null;

export function tourShowing() {
  return tourStepIndex >= 0;
}

function markTourDone() {
  try { localStorage.setItem(TOUR_DONE_KEY, "1"); } catch (e) {}
}

function tourTarget(step) {
  var el = document.querySelector(step.selector);
  if (el && el.id && !el.getClientRects().length) {
    var tab = document.querySelector('#phone-bar [data-for="' + el.id + '"]');
    if (tab && tab.getClientRects().length) return tab;
  }
  return el;
}

function positionTourStep() {
  if (tourStepIndex < 0) return;
  var step = TOUR_STEPS[tourStepIndex];
  var target = tourTarget(step);
  var cutout = document.getElementById("tour-cutout");
  var card = document.getElementById("tour-card");
  if (!target || !cutout || !card) { endTour(false); return; }

  var r = target.getBoundingClientRect();
  var pad = 6;
  cutout.style.left = (r.left - pad) + "px";
  cutout.style.top = (r.top - pad) + "px";
  cutout.style.width = (r.width + pad * 2) + "px";
  cutout.style.height = (r.height + pad * 2) + "px";

  var vw = window.innerWidth, vh = window.innerHeight;
  if (vw <= 480) {
    card.style.left = "";
    card.style.top = "";
    return;
  }

  var cardW = card.offsetWidth || 300;
  var cardH = card.offsetHeight || 180;
  var left, top;
  if (r.right + 16 + cardW <= vw) {
    left = r.right + 16;
    top = Math.max(16, Math.min(r.top, vh - cardH - 16));
  } else if (r.left - 16 - cardW >= 0) {
    left = r.left - 16 - cardW;
    top = Math.max(16, Math.min(r.top, vh - cardH - 16));
  } else if (r.bottom + 16 + cardH <= vh) {
    left = Math.max(16, Math.min(r.left, vw - cardW - 16));
    top = r.bottom + 16;
  } else {
    left = Math.max(16, Math.min(r.left, vw - cardW - 16));
    top = Math.max(16, r.top - cardH - 16);
  }
  card.style.left = left + "px";
  card.style.top = top + "px";
}

function renderTourStep() {
  var step = TOUR_STEPS[tourStepIndex];
  document.getElementById("tour-step").textContent = "Step " + (tourStepIndex + 1) + " of " + TOUR_STEPS.length;
  document.getElementById("tour-title").textContent = step.title;
  document.getElementById("tour-body").textContent = step.body;

  var link = document.getElementById("tour-readmore");
  link.onclick = function (e) {
    e.preventDefault();
    openHelp(step.slug);
  };

  document.getElementById("tour-back").disabled = tourStepIndex === 0;
  document.getElementById("tour-next").textContent =
    tourStepIndex === TOUR_STEPS.length - 1 ? "Finish" : "Next";

  var taggingHelp = document.getElementById("tagging-help");
  if (taggingHelp) taggingHelp.hidden = !step.showTaggingHelp;

  var target = tourTarget(step);
  if (target && target.scrollIntoView) target.scrollIntoView({ block: "center" });
  positionTourStep();
}

function dismissPausedToast() {
  var el = tourPausedToast;
  tourPausedToast = null;
  if (el) el.dismiss();
}

function interruptTour() {
  dismissPausedToast();
  var at = tourStepIndex >= 0 ? tourStepIndex : tourSuspendedAt;
  if (at < 0) return;
  tourInterruptedAt = at;
  tourSuspendedAt = -1;
  tourStepIndex = -1;
  var overlay = document.getElementById("tour-overlay");
  if (overlay) overlay.hidden = true;
  var taggingHelp = document.getElementById("tagging-help");
  if (taggingHelp) taggingHelp.hidden = tourTaggingHelpWasHidden;
}

function resumePausedTour() {
  tourPausedToast = null;
  tourResumeFrom = tourInterruptedAt;
  var outcome = appActions.invoke("tour", "button");
  tourResumeFrom = -1;
  if (outcome.kind !== "ran") offerTourResume();
}

function offerTourResume() {
  if (tourInterruptedAt < 0) return;
  dismissPausedToast();
  var el = showActionToast("The tour was paused.", "", "Resume tour", resumePausedTour, true);
  tourPausedToast = el;
  el.addEventListener("click", function () {
    if (tourPausedToast !== el) return;
    tourPausedToast = null;
    tourInterruptedAt = -1;
  });
}

export function startTour() {
  var from = tourResumeFrom;
  tourResumeFrom = -1;
  if (!S.state) {
    if (typeof showToast === "function") showToast("Still loading…", "warn");
    return;
  }
  var overlay = document.getElementById("tour-overlay");
  if (!overlay) return;
  closeAllSidePanels();
  tourSuspendedAt = -1;
  tourInterruptedAt = -1;
  dismissPausedToast();
  closeHelp();
  var taggingHelp = document.getElementById("tagging-help");
  tourTaggingHelpWasHidden = taggingHelp ? taggingHelp.hidden : true;

  tourStepIndex = from >= 0 ? from : 0;
  overlay.hidden = false;
  renderTourStep();

  if (!tourResizeHandler) {
    tourResizeHandler = function () { positionTourStep(); };
    window.addEventListener("resize", tourResizeHandler);
    window.addEventListener("scroll", tourResizeHandler, true);
  }
}

function endTour() {
  tourSuspendedAt = -1;
  var overlay = document.getElementById("tour-overlay");
  if (overlay) overlay.hidden = true;
  var taggingHelp = document.getElementById("tagging-help");
  if (taggingHelp) taggingHelp.hidden = tourTaggingHelpWasHidden;
  tourStepIndex = -1;
  markTourDone();
}

function tourNext() {
  if (tourStepIndex < TOUR_STEPS.length - 1) { tourStepIndex++; renderTourStep(); }
  else endTour();
}

function tourBack() {
  if (tourStepIndex > 0) { tourStepIndex--; renderTourStep(); }
}

export function __init() {
  handTourPauseTo({ interrupt: interruptTour, offerResume: offerTourResume });
  injectTaggingHelpGuideLink();

  (function wireHelpModal() {
    var modal = document.getElementById("help-modal");
    var toc = document.getElementById("help-toc");
    if (!modal) return;

    var closeBtn = document.getElementById("help-close");
    if (closeBtn) closeBtn.addEventListener("click", closeHelp);

    modal.addEventListener("click", function (e) {
      if (e.target.id === "help-modal") closeHelp();
    });

    if (toc) {
      toc.addEventListener("click", function (e) {
        var a = e.target.closest('a[href^="#"]');
        if (!a) return;
        e.preventDefault();
        scrollHelpTo(a.getAttribute("href").slice(1));
      });
    }

    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.hidden) { e.preventDefault(); closeHelp(); }
    });

    document.addEventListener("focusin", function (e) {
      if (modal.hidden || modal.contains(e.target)) return;
      e.stopPropagation();
      var target = document.getElementById("help-close");
      if (target) target.focus();
    });
  })();

  (function wireTour() {
    var overlay = document.getElementById("tour-overlay");
    if (!overlay) return;
    document.getElementById("tour-next").addEventListener("click", tourNext);
    document.getElementById("tour-back").addEventListener("click", tourBack);
    document.getElementById("tour-skip").addEventListener("click", function () { endTour(); });
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !e.defaultPrevented && !overlay.hidden) {
        e.preventDefault();
        endTour();
      }
    });
  })();
}
