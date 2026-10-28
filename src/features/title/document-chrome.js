import { escapeHtml } from "../../core/document/text-policy.ts";
import { wordsPerMinuteCommand } from "../../application/commands/document-settings.ts";
import { DEFAULT_WPM } from "../../core/document/timing.ts";
import { getSavedAuthorName } from "../../application/comment-author.js";
import { cleanAuthorName } from "../../core/document/people.ts";
import { PERSON_COLORS, PERSON_COLOR_NAMES } from "../../core/document/person-colors.ts";
import { targetSectionHtml, wireTargetSection } from "./target-section.js";

export function startDocumentChrome(ports) {
  var active = true;
  var currentDocument = ports.document.current;
  var preferences = function () { return ports.preferences; };
  var personColors = ports.personColors;
  var runDocumentEdit = ports.edits.edit;
  var targetSection = ports;
function updateIdentityChip() {
  var name = getSavedAuthorName(preferences());
  var chip = document.getElementById("identity-chip");
  document.getElementById("identity-name").textContent = name || "Set your name";
  chip.classList.toggle("unnamed", !name);
  var dot = chip.querySelector(".identity-dot");
  if (dot) {
    dot.setAttribute("aria-hidden", "true");
    if (name) dot.style.setProperty("--person", personColors.personColor(name));
    else dot.style.removeProperty("--person");
  }
}

function identityChipListeners() {
  return {
    session: function (change) {
      if (change.changes.whole || change.changes.docFields.indexOf("personColors") !== -1) updateIdentityChip();
    },
    preference: function (change) {
      var name = preferences().nameOf(change.key);
      if (name === "commentAuthor" || name === "personColor") updateIdentityChip();
    }
  };
}

var anchorPopover = null;

function closeAnchorPopover(opts) {
  var p = anchorPopover;
  if (!p) return;
  anchorPopover = null;
  document.removeEventListener("pointerdown", p.onOutside, true);
  document.removeEventListener("keydown", p.onKey, true);
  window.removeEventListener("resize", p.place);
  window.removeEventListener("scroll", p.place, true);
  p.el.remove();
  p.host.setAttribute("aria-expanded", "false");
  if (!(opts && opts.keepFocus) && document.contains(p.host)) {
    try { p.host.focus({ preventScroll: true }); } catch (e) { p.host.focus(); }
  }
}

function placeAnchorPopover(el, host) {
  var margin = 8, gap = 6;
  var r = host.getBoundingClientRect();
  var vw = document.documentElement.clientWidth || window.innerWidth;
  var vh = window.innerHeight;
  el.style.maxWidth = (vw - margin * 2) + "px";
  var w = el.offsetWidth, h = el.offsetHeight;
  var left = r.left + r.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, vw - margin - w));
  var top = r.bottom + gap;
  if (top + h > vh - margin && r.top - gap - h >= margin) top = r.top - gap - h;
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
  el.classList.toggle("is-above", top < r.top);
}

function openAnchorPopover(host, id, label, html) {
  var wasOpen = anchorPopover && anchorPopover.el.id === id;
  closeAnchorPopover({ keepFocus: true });
  if (wasOpen) { host.focus(); return null; }
  var el = document.createElement("div");
  el.id = id;
  el.className = "anchor-popover";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  document.body.appendChild(el);
  var p = {
    el: el,
    host: host,
    place: function () { placeAnchorPopover(el, host); },
    onOutside: function (e) {
      if (el.contains(e.target) || host.contains(e.target)) return;
      closeAnchorPopover({ keepFocus: true });
    },
    onKey: function (e) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeAnchorPopover();
    }
  };
  anchorPopover = p;
  host.setAttribute("aria-expanded", "true");
  p.place();
  document.addEventListener("pointerdown", p.onOutside, true);
  document.addEventListener("keydown", p.onKey, true);
  window.addEventListener("resize", p.place);
  window.addEventListener("scroll", p.place, true);
  return el;
}

function personSwatchesHtml(name, radioName, legendClass) {
  var current = preferences().myColor() || personColors.personColor(name || "");
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
  var current = getSavedAuthorName(preferences());
  var host = document.getElementById("identity-chip");
  var wrap = openAnchorPopover(host, "identity-editor", "Your name and colour",
    '<label class="anchor-popover-label" for="identity-input">Your name</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="text" id="identity-input" placeholder="Your name" autocomplete="name" value="' + escapeHtml(current) + '">' +
      '<button type="button" id="identity-save" class="btn-outline">Save</button>' +
    '</div>' +
    personSwatchesHtml(current));
  if (!wrap) return;
  var input = document.getElementById("identity-input");
  input.focus();
  input.select();
  function commit() {
    var v = (input.value || "").trim();
    if (v) preferences().setCommentAuthor(cleanAuthorName(v));
    closeAnchorPopover();
  }
  document.getElementById("identity-save").addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });
  wrap.addEventListener("change", function (e) {
    if (e.target && e.target.name === "person-color") preferences().setMyColor(e.target.value);
  });
}

function lengthHost() {
  var phone = document.getElementById("length-status");
  if (phone && phone.getClientRects().length) return phone;
  return document.getElementById("runtime-chip");
}

function promptForWpm() {
  openClockPopover("wpm");
}

function promptForTarget() {
  openClockPopover("target");
}

function openClockPopover(focusOn) {
  if (!currentDocument()) return;
  var host = lengthHost();
  var wrap = openAnchorPopover(host, "wpm-editor", "Reading speed and target length",
    '<label class="anchor-popover-label" for="wpm-input">Reading speed</label>' +
    '<div class="anchor-popover-row">' +
      '<input type="number" id="wpm-input" min="60" max="400" step="5" value="' +
        escapeHtml(String(currentDocument().wordsPerMinute || DEFAULT_WPM)) + '" aria-label="Words per minute">' +
      '<span class="anchor-popover-unit">words a minute</span>' +
      '<button type="button" id="wpm-save" class="btn-outline">Set</button>' +
    '</div>' +
    targetSectionHtml(targetSection));
  if (!wrap) return;
  wireTargetSection(targetSection, wrap, closeAnchorPopover);
  var targetInput = document.getElementById("target-input");
  var input = document.getElementById("wpm-input");
  var first = focusOn === "target" && targetInput ? targetInput : input;
  first.focus();
  first.select();
  function commit() {
    runDocumentEdit(wordsPerMinuteCommand(Number(input.value)));
    closeAnchorPopover();
  }
  document.getElementById("wpm-save").addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });
}


  function guarded(fn) {
    return function (...args) {
      if (!active) throw new Error("The document chrome is not started yet");
      return fn(...args);
    };
  }
  return {
    updateIdentityChip: guarded(updateIdentityChip), identityChipListeners: guarded(identityChipListeners),
    personSwatchesHtml: guarded(personSwatchesHtml), promptForName: guarded(promptForName),
    promptForWpm: guarded(promptForWpm), promptForTarget: guarded(promptForTarget),
    dispose: function () { if (!active) return; active = false; closeAnchorPopover({ keepFocus: true }); }
  };
}
