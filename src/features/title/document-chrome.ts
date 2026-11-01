import { escapeHtml } from "../../core/document/text-policy.ts";
import { wordsPerMinuteCommand } from "../../application/commands/document-settings.ts";
import { DEFAULT_WPM } from "../../core/document/timing.ts";
import { getSavedAuthorName } from "../../application/comment-author.ts";
import { cleanAuthorName } from "../../core/document/people.ts";
import { PERSON_COLORS, PERSON_COLOR_NAMES } from "../../core/document/person-colors.ts";
import { targetSectionHtml, wireTargetSection } from "./target-section.ts";
import type { DocumentChromePorts, DocumentChromeControl } from "./ports.ts";
import type { DocumentShape } from "../../core/document/validated.ts";

type AnchorPopover = { el: HTMLElement; host: HTMLElement | null; place: () => void; onOutside: (e: PointerEvent) => void; onKey: (e: KeyboardEvent) => void };

export function startDocumentChrome(ports: DocumentChromePorts) {
  let active = true;
  const currentDocument = ports.document.current;
  const preferences = function () { return ports.preferences; };
  const personColors = ports.personColors;
  const runDocumentEdit = ports.edits.edit;
  const targetSection = ports;
function updateIdentityChip() {
  const name = getSavedAuthorName(preferences());
  const chip = document.getElementById("identity-chip");
  (document.getElementById("identity-name") as HTMLElement).textContent = name || "Set your name";
  (chip as HTMLElement).classList.toggle("unnamed", !name);
  const dot = (chip as HTMLElement).querySelector<HTMLElement>(".identity-dot");
  if (dot) {
    dot.setAttribute("aria-hidden", "true");
    if (name) dot.style.setProperty("--person", personColors.personColor(name));
    else dot.style.removeProperty("--person");
  }
}

function identityChipListeners(): ReturnType<DocumentChromeControl["identityChipListeners"]> {
  return {
    session: function (change) {
      if (change.changes.whole || change.changes.docFields.indexOf("personColors") !== -1) updateIdentityChip();
    },
    preference: function (change) {
      const name = preferences().nameOf(change.key);
      if (name === "commentAuthor" || name === "personColor") updateIdentityChip();
    }
  };
}

let anchorPopover: AnchorPopover | null = null;

function closeAnchorPopover(opts?: { keepFocus?: boolean }) {
  const p = anchorPopover;
  if (!p) return;
  anchorPopover = null;
  document.removeEventListener("pointerdown", p.onOutside, true);
  document.removeEventListener("keydown", p.onKey, true);
  window.removeEventListener("resize", p.place);
  window.removeEventListener("scroll", p.place, true);
  p.el.remove();
  (p.host as HTMLElement).setAttribute("aria-expanded", "false");
  if (!(opts && opts.keepFocus) && document.contains(p.host)) {
    try { (p.host as HTMLElement).focus({ preventScroll: true }); } catch (e) { (p.host as HTMLElement).focus(); }
  }
}

function placeAnchorPopover(el: HTMLElement, host: HTMLElement | null) {
  const margin = 8, gap = 6;
  const r = (host as HTMLElement).getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  el.style.maxWidth = (vw - margin * 2) + "px";
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, vw - margin - w));
  let top = r.bottom + gap;
  if (top + h > vh - margin && r.top - gap - h >= margin) top = r.top - gap - h;
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
  el.classList.toggle("is-above", top < r.top);
}

function openAnchorPopover(host: HTMLElement | null, id: string, label: string, html: string) {
  const wasOpen = anchorPopover && anchorPopover.el.id === id;
  closeAnchorPopover({ keepFocus: true });
  if (wasOpen) { (host as HTMLElement).focus(); return null; }
  const el = document.createElement("div");
  el.id = id;
  el.className = "anchor-popover";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  document.body.appendChild(el);
  const p = {
    el: el,
    host: host,
    place: function () { placeAnchorPopover(el, host); },
    onOutside: function (e: PointerEvent) {
      if (el.contains(e.target as Node | null) || (host as HTMLElement).contains(e.target as Node | null)) return;
      closeAnchorPopover({ keepFocus: true });
    },
    onKey: function (e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAnchorPopover();
    }
  };
  anchorPopover = p;
  (host as HTMLElement).setAttribute("aria-expanded", "true");
  p.place();
  document.addEventListener("pointerdown", p.onOutside, true);
  document.addEventListener("keydown", p.onKey, true);
  window.addEventListener("resize", p.place);
  window.addEventListener("scroll", p.place, true);
  return el;
}

function personSwatchesHtml(name: string, radioName?: string, legendClass?: string) {
  const current = preferences().myColor() || personColors.personColor(name || "");
  return '<fieldset class="swatch-group" role="radiogroup" aria-label="Your colour">' +
    '<legend class="' + (legendClass || "anchor-popover-label") + '">Your colour</legend>' +
    '<div class="swatch-row">' +
    PERSON_COLORS.map(function (c, i) {
      return '<label class="swatch" style="--swatch:' + c + '" title="' + PERSON_COLOR_NAMES[i] + '">' +
        '<input type="radio" name="' + (radioName || "person-color") + '" value="' + c + '" aria-label="' + PERSON_COLOR_NAMES[i] + '"' +
          (c === current ? " checked" : "") + '>' +
        '<span class="swatch-dot" aria-hidden="true"></span></label>';
    }).join("") +
    '</div></fieldset>';
}

function promptForName() {
  const current = getSavedAuthorName(preferences());
  const host = document.getElementById("identity-chip");
  const wrap = openAnchorPopover(host, "identity-editor", "Your name and colour",
    '<label class="anchor-popover-label" for="identity-input">Your name</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="text" id="identity-input" placeholder="Your name" autocomplete="name" value="' + escapeHtml(current) + '">' +
      '<button type="button" id="identity-save" class="btn-outline">Save</button>' +
    '</div>' +
    personSwatchesHtml(current));
  if (!wrap) return;
  const input = document.getElementById("identity-input") as HTMLInputElement;
  input.focus();
  input.select();
  function commit() {
    const v = (input.value || "").trim();
    if (v) preferences().setCommentAuthor(cleanAuthorName(v));
    closeAnchorPopover();
  }
  (document.getElementById("identity-save") as HTMLElement).addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });
  wrap.addEventListener("change", function (e) {
    if (e.target && (e.target as HTMLInputElement).name === "person-color") preferences().setMyColor((e.target as HTMLInputElement).value);
  });
}

function lengthHost() {
  const phone = document.getElementById("length-status");
  if (phone && phone.getClientRects().length) return phone;
  return document.getElementById("runtime-chip");
}

function promptForWpm() {
  openClockPopover("wpm");
}

function promptForTarget() {
  openClockPopover("target");
}

function openClockPopover(focusOn: string) {
  if (!currentDocument()) return;
  const host = lengthHost();
  const wrap = openAnchorPopover(host, "wpm-editor", "Reading speed and target length",
    '<label class="anchor-popover-label" for="wpm-input">Reading speed</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="number" id="wpm-input" min="60" max="400" step="5" value="' +
        escapeHtml(String((currentDocument() as Partial<Pick<DocumentShape, "wordsPerMinute">>).wordsPerMinute || DEFAULT_WPM)) + '" aria-label="Words per minute">' +
      '<span class="anchor-popover-unit">words a minute</span>' +
      '<button type="button" id="wpm-save" class="btn-outline">Set</button>' +
    '</div>' +
    targetSectionHtml(targetSection));
  if (!wrap) return;
  wireTargetSection(targetSection, wrap, closeAnchorPopover);
  const targetInput = document.getElementById("target-input") as HTMLInputElement | null;
  const input = document.getElementById("wpm-input") as HTMLInputElement;
  const first = focusOn === "target" && targetInput ? targetInput : input;
  first.focus();
  first.select();
  function commit() {
    runDocumentEdit(wordsPerMinuteCommand(Number(input.value)));
    closeAnchorPopover();
  }
  (document.getElementById("wpm-save") as HTMLElement).addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });
}


  function guarded<T extends (...args: never[]) => unknown>(fn: T): T {
    return function (...args: Parameters<T>) {
      if (!active) throw new Error("The document chrome is not started yet");
      return fn(...args);
    } as T;
  }
  return {
    updateIdentityChip: guarded(updateIdentityChip), identityChipListeners: guarded(identityChipListeners),
    personSwatchesHtml: guarded(personSwatchesHtml), promptForName: guarded(promptForName),
    promptForWpm: guarded(promptForWpm), promptForTarget: guarded(promptForTarget),
    dispose: function () { if (!active) return; active = false; closeAnchorPopover({ keepFocus: true }); }
  };
}
