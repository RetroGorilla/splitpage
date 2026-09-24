import { S } from "./_state.js";
import { syncPanelClass } from "./03-sync.js";
import { SIDE_PANEL_IDS } from "./03b-side-panels.js";
import { showToast } from "./12-dirty-toast.js";
import { toggleFileMenu } from "./18b-file-menu.js";

/* ================= Help page (docs/help.md) & the coach-mark tour ============

   #help-modal's body and TOC are rendered from docs/help.md at BUILD time by
   mdToHtml() in build.mjs — nothing here parses Markdown. (It was README.md
   until #80, which split the user guide out so the repo's README could change
   without rebuilding the app.) This fragment
   only wires the modal chrome, the coach-mark tour, and the two new
   File-menu items ("User guide…" / "Take the tour").

   Unlike every other fragment, this one's top-level wiring runs directly
   rather than through init() (21-events.js) — 21-events.js is off limits
   for this change, and it doesn't need to know about these two features:
   #help-modal, #tour-overlay and #file-menu already exist in the DOM by
   the time this classic <script> runs (it sits after them, and a classic
   script pauses the parser in place — see PAGE_SHELL's own comment in
   00-prelude.js for the same reasoning), so binding listeners here
   immediately is exactly as safe as doing it from init(). */

/* Anything that opens over the whole screen has to close the side panels
   first (invariant #16) — the same thing openWriter()/openPrompter() do.
   SIDE_PANEL_IDS is 03b-side-panels.js's one list; this file used to keep
   its own copy under another name (#59). */
export function closeSidePanelsForHelp() {
  SIDE_PANEL_IDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  if (typeof syncPanelClass === "function") syncPanelClass();
}

/* Scrolls #help-body itself, never the page — the modal is the whole
   viewport already, but the TOC and deep links must not rely on native
   anchor-jump behaviour picking the right scrolling ancestor. */
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
  /* Two full-screen overlays at once serve nobody, so the tour steps
     aside — but reading the section a step points at is part of taking
     the tour, not a reason to end it. Remember where the reader was;
     closeHelp() brings them back. */
  suspendTourForHelp();
  closeSidePanelsForHelp();
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

/* Both halves of the pause. Hiding the overlay and parking the index at
   -1 keeps the scroll/resize handler a no-op while the guide is up; the
   tagging strip is left exactly as the tour set it, because the tour is
   coming back to the same step. Neither half marks the tour done. */
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

/* The static "Tagging quick reference" strip (page.html, wired by
   10-comments.js — off limits here) gets one more line pointing at the
   full guide. Added from script rather than in the markup, since this
   fragment may only APPEND new blocks to page.html, not edit existing
   ones. Idempotent so a rebuild/re-render never double-inserts it. */
function injectTaggingHelpGuideLink() {
  var body = document.querySelector("#tagging-help .tagging-help-body");
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

/* ================= coach-mark tour ================= */

export var TOUR_DONE_KEY = "splitpage-tour-done";

/* Document-agnostic on purpose (invariant #17: a hint about the document
   must never edit it, and this copy must never assume WHAT the seed
   document says either) — every sentence describes the feature, never
   the demo script's content. Slugs are real docs/help.md headings, verified
   against build.mjs's slugify() rather than guessed. */
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
/* Set while the guide is open OVER a tour: the tour is paused, not over,
   and closing the guide puts the reader back on the step they left. -1
   means no tour is waiting. */
var tourSuspendedAt = -1;

function markTourDone() {
  try { localStorage.setItem(TOUR_DONE_KEY, "1"); } catch (e) {}
}

/* A step's element, or at phone width its stand-in: the header's panel
   buttons are not drawn there, and the bottom bar's tab that clicks one
   (#169, #phone-bar, data-for) is what the reader can see and tap. */
function tourTarget(step) {
  var el = document.querySelector(step.selector);
  if (el && el.id && !el.getClientRects().length) {
    var tab = document.querySelector('#phone-bar [data-for="' + el.id + '"]');
    if (tab && tab.getClientRects().length) return tab;
  }
  return el;
}

/* Recomputes the cut-out and card position from the target's own live
   rect — following the hideTagGhost recompute-on-scroll/resize pattern
   (21-events.js) rather than caching a rect that a layout change (or a
   panel closing) would make stale. */
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
    /* Phone layout: the card goes full-width under the cut-out — handled
       entirely by CSS (.tour-card at max-width:480px is position:fixed
       to the bottom), so there is nothing to compute here. */
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

  /* openHelp() pauses the tour and closing the guide resumes it on this
     same step, so a reader can look something up without losing their
     place — and without the tour quietly counting itself finished. */
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

export function startTour() {
  if (!S.state) {
    if (typeof showToast === "function") showToast("Still loading…", "warn");
    return;
  }
  var overlay = document.getElementById("tour-overlay");
  if (!overlay) return;
  closeSidePanelsForHelp();
  /* Cleared first: closeHelp() resumes a suspended tour, and this is a
     fresh one starting from step 1. */
  tourSuspendedAt = -1;
  closeHelp();
  var taggingHelp = document.getElementById("tagging-help");
  tourTaggingHelpWasHidden = taggingHelp ? taggingHelp.hidden : true;

  tourStepIndex = 0;
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

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
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

    /* A modal owns focus, not just the pixels (invariant #19): anything
       that lands focus outside it while it's open gets pulled straight
       back in, the same shape as the writer's #writer focusin trap. */
    document.addEventListener("focusin", function (e) {
      if (modal.hidden || modal.contains(e.target)) return;
      e.stopPropagation();
      var target = document.getElementById("help-close");
      if (target) target.focus();
    });
  })();

  /* ---- File menu: "User guide…" / "Take the tour" ----

     handleFileMenuAction() (18-local-files.js) has no branches for these
     two actions and must not need any — a capture-phase listener on the
     SAME #file-menu element sees the click first and, when it's ours,
     calls stopPropagation(). Both listeners sit on this one element, so
     that halts the dispatch entirely: the event never reaches AT_TARGET or
     bubbles back up to 18-local-files.js's own (bubble-phase) listener.
     toggleFileMenu() is 18b-file-menu.js's own menu-close function, reused so
     File ▾'s aria-expanded state never disagrees with whether it's open. */
  (function wireHelpFileMenuItems() {
    var menu = document.getElementById("file-menu");
    if (!menu) return;
    menu.addEventListener("click", function (e) {
      var item = e.target.closest('[data-file-action="help"], [data-file-action="tour"]');
      if (!item) return;
      e.stopPropagation();
      if (typeof toggleFileMenu === "function") toggleFileMenu(false);
      if (item.getAttribute("data-file-action") === "help") openHelp();
      else startTour();
    }, true);
  })();

  (function wireTour() {
    var overlay = document.getElementById("tour-overlay");
    if (!overlay) return;
    document.getElementById("tour-next").addEventListener("click", tourNext);
    document.getElementById("tour-back").addEventListener("click", tourBack);
    document.getElementById("tour-skip").addEventListener("click", function () { endTour(); });
    /* defaultPrevented, because the guide's own Escape handler (also on
       window, registered earlier) closes Help on the same event — and
       closing Help puts a suspended tour back on screen. Without this
       guard that one keypress would close the guide and then immediately
       skip the tour it had just restored. */
    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !e.defaultPrevented && !overlay.hidden) {
        e.preventDefault();
        endTour();
      }
    });
  })();
}
