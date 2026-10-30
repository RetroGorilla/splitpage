import type { HelpPorts, HelpMount } from "./ports.ts";
import { addListener } from "../common/listeners.ts";

interface HelpPortUse extends Omit<HelpPorts, "document"> {
  readonly document: {
    readonly [K in keyof HelpPorts["document"]]: (...args: Parameters<HelpPorts["document"][K]>) => unknown;
  };
}

let ports: HelpPorts | null = null;
const listeners: Array<() => void> = [];

function scrollHelpTo(id: string) {
  const body = document.getElementById("help-body");
  const target = id && document.getElementById(id);
  if (!body || !target) return;
  const bodyRect = body.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  body.scrollTop += (targetRect.top - bodyRect.top) - 12;
}

let helpReturnFocus: (Element & { focus?: unknown }) | null = null;

function openHelp(anchor?: string) {
  const modal = document.getElementById("help-modal");
  if (!modal) return;
  suspendTourForHelp();
  (ports as HelpPortUse).sidePanels.closeAll();
  helpReturnFocus = document.activeElement;
  modal.hidden = false;
  if (anchor) scrollHelpTo(anchor);
  else {
    const body = document.getElementById("help-body");
    if (body) body.scrollTop = 0;
  }
  const closeBtn = document.getElementById("help-close");
  if (closeBtn) closeBtn.focus();
}

function closeHelp() {
  const modal = document.getElementById("help-modal");
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
  const overlay = document.getElementById("tour-overlay");
  if (!overlay) return;
  tourSuspendedAt = tourStepIndex;
  tourStepIndex = -1;
  (ports as HelpPortUse).viewFlags.setTourOpen(false);
  overlay.hidden = true;
}

function resumeTourAfterHelp() {
  const at = tourSuspendedAt;
  tourSuspendedAt = -1;
  if (at < 0) return;
  const overlay = document.getElementById("tour-overlay");
  if (!overlay) return;
  tourStepIndex = at;
  (ports as HelpPortUse).viewFlags.setTourOpen(true);
  overlay.hidden = false;
  renderTourStep();
}

function injectTaggingHelpGuideLink() {
  const body = document.querySelector("#tagging-help .tagging-help-foot") ||
    document.querySelector("#tagging-help .tagging-help-body");
  if (!body || document.getElementById("tagging-help-fullguide")) return;
  const wrap = document.createElement("div");
  wrap.className = "tagging-help-fullguide";
  wrap.id = "tagging-help-fullguide";
  const a = document.createElement("a");
  a.href = "#";
  a.textContent = "Open the full guide";
  listeners.push(addListener(a, "click", function (e) {
    e.preventDefault();
    openHelp("help-tagging-and-the-production-breakdown");
  }));
  wrap.appendChild(a);
  body.appendChild(wrap);
}


interface HelpTourStep {
  selector: string;
  title: string;
  body: string;
  slug: string;
  showTaggingHelp?: boolean;
}

const TOUR_STEPS: HelpTourStep[] = [
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

let tourStepIndex = -1;
let tourResizeHandler: EventListener | null = null;
let tourTaggingHelpWasHidden: boolean | "until-found" = true;
let tourSuspendedAt = -1;

export function tourShowing() {
  return tourStepIndex >= 0;
}

function markTourDone() {
  (ports as HelpPortUse).preferences.tourFinished();
}

function tourTarget(step: typeof TOUR_STEPS[number]) {
  const el = document.querySelector(step.selector);
  if (el && el.id && !el.getClientRects().length) {
    const tab = document.querySelector('#phone-bar [data-for="' + el.id + '"]');
    if (tab && tab.getClientRects().length) return tab;
  }
  return el;
}

function positionTourStep() {
  if (tourStepIndex < 0) return;
  const step = TOUR_STEPS[tourStepIndex] as HelpTourStep;
  const target = tourTarget(step);
  const cutout = document.getElementById("tour-cutout");
  const card = document.getElementById("tour-card");
  if (!target || !cutout || !card) { (endTour as (value: boolean) => void)(false); return; }

  const r = target.getBoundingClientRect();
  const pad = 6;
  cutout.style.left = (r.left - pad) + "px";
  cutout.style.top = (r.top - pad) + "px";
  cutout.style.width = (r.width + pad * 2) + "px";
  cutout.style.height = (r.height + pad * 2) + "px";

  const vw = window.innerWidth, vh = window.innerHeight;
  if (vw <= 480) {
    card.style.left = "";
    card.style.top = "";
    return;
  }

  const cardW = card.offsetWidth || 300;
  const cardH = card.offsetHeight || 180;
  let left, top;
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
  const step = TOUR_STEPS[tourStepIndex] as HelpTourStep;
  (document.getElementById("tour-step") as HTMLElement).textContent = "Step " + (tourStepIndex + 1) + " of " + TOUR_STEPS.length;
  (document.getElementById("tour-title") as HTMLElement).textContent = step.title;
  (document.getElementById("tour-body") as HTMLElement).textContent = step.body;

  const link = document.getElementById("tour-readmore") as HTMLElement;
  link.onclick = function (e) {
    e.preventDefault();
    openHelp(step.slug);
  };
  tourReadMoreLink = link;

  (document.getElementById("tour-back") as HTMLButtonElement).disabled = tourStepIndex === 0;
  (document.getElementById("tour-next") as HTMLElement).textContent =
    tourStepIndex === TOUR_STEPS.length - 1 ? "Finish" : "Next";

  const taggingHelp = document.getElementById("tagging-help");
  if (taggingHelp) taggingHelp.hidden = !step.showTaggingHelp;

  const target = tourTarget(step);
  if (target && target.scrollIntoView) target.scrollIntoView({ block: "center" });
  positionTourStep();
}

function startTour() {
  if (!(ports as HelpPortUse).document.current()) {
    (ports as HelpPortUse).notices.show("Still loading…", "warn");
    return;
  }
  const overlay = document.getElementById("tour-overlay");
  if (!overlay) return;
  (ports as HelpPortUse).sidePanels.closeAll();
  tourSuspendedAt = -1;
  closeHelp();
  const taggingHelp = document.getElementById("tagging-help");
  tourTaggingHelpWasHidden = taggingHelp ? taggingHelp.hidden : true;

  tourStepIndex = 0;
  (ports as HelpPortUse).viewFlags.setTourOpen(true);
  overlay.hidden = false;
  renderTourStep();

  if (!tourResizeHandler) {
    tourResizeHandler = function () { positionTourStep(); };
    listeners.push(addListener(window, "resize", tourResizeHandler));
    listeners.push(addListener(window, "scroll", tourResizeHandler, true));
  }
}

function endTour() {
  tourSuspendedAt = -1;
  const overlay = document.getElementById("tour-overlay");
  if (overlay) overlay.hidden = true;
  const taggingHelp = document.getElementById("tagging-help");
  if (taggingHelp) taggingHelp.hidden = tourTaggingHelpWasHidden;
  tourStepIndex = -1;
  (ports as HelpPortUse).viewFlags.setTourOpen(false);
  markTourDone();
}

function tourNext() {
  if (tourStepIndex < TOUR_STEPS.length - 1) { tourStepIndex++; (ports as HelpPortUse).viewFlags.setTourOpen(true); renderTourStep(); }
  else endTour();
}

function tourBack() {
  if (tourStepIndex > 0) { tourStepIndex--; (ports as HelpPortUse).viewFlags.setTourOpen(true); renderTourStep(); }
}

let tourReadMoreLink: HTMLElement | null = null;

export function startHelp(given: HelpPorts): HelpMount {
  ports = given;
  const guideExisted = document.getElementById("tagging-help-fullguide");
  injectTaggingHelpGuideLink();

  (function wireHelpModal() {
    const modal = document.getElementById("help-modal");
    const toc = document.getElementById("help-toc");
    if (!modal) return;

    const closeBtn = document.getElementById("help-close");
    if (closeBtn) listeners.push(addListener(closeBtn, "click", closeHelp));

    listeners.push(addListener(modal, "click", function (e) {
      if ((e.target as HTMLElement).id === "help-modal") closeHelp();
    }));

    if (toc) {
      listeners.push(addListener(toc, "click", function (e) {
        const a = (e.target as HTMLElement).closest('a[href^="#"]');
        if (!a) return;
        e.preventDefault();
        scrollHelpTo((a.getAttribute("href") as string).slice(1));
      }));
    }

    listeners.push(addListener(window, "keydown", function (e) {
      if ((e as KeyboardEvent).key === "Escape" && !modal.hidden) { e.preventDefault(); closeHelp(); }
    }));

    listeners.push(addListener(document, "focusin", function (e) {
      if (modal.hidden || modal.contains(e.target as Node | null)) return;
      e.stopPropagation();
      const target = document.getElementById("help-close");
      if (target) target.focus();
    }));
  })();

  (function wireTour() {
    const overlay = document.getElementById("tour-overlay");
    if (!overlay) return;
    listeners.push(addListener(document.getElementById("tour-next") as HTMLElement, "click", tourNext));
    listeners.push(addListener(document.getElementById("tour-back") as HTMLElement, "click", tourBack));
    listeners.push(addListener(document.getElementById("tour-skip") as HTMLElement, "click", function () { endTour(); }));
    listeners.push(addListener(window, "keydown", function (e) {
      if ((e as KeyboardEvent).key === "Escape" && !e.defaultPrevented && !overlay.hidden) {
        e.preventDefault();
        endTour();
      }
    }));
  })();
  let disposed = false;
  return {
    openHelp, startTour,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      while (listeners.length) (listeners.pop() as () => void)();
      if (tourReadMoreLink) tourReadMoreLink.onclick = null;
      tourReadMoreLink = null;
      const overlay = document.getElementById("tour-overlay");
      if (overlay) overlay.hidden = true;
      const modal = document.getElementById("help-modal");
      if (modal) modal.hidden = true;
      const taggingHelp = document.getElementById("tagging-help");
      if (taggingHelp && tourStepIndex >= 0) taggingHelp.hidden = tourTaggingHelpWasHidden;
      if (!guideExisted) {
        const guide = document.getElementById("tagging-help-fullguide");
        if (guide) guide.remove();
      }
      (ports as HelpPortUse).viewFlags.setTourOpen(false);
      tourStepIndex = tourSuspendedAt = -1;
      tourResizeHandler = helpReturnFocus = null;
      ports = null;
    }
  };
}
