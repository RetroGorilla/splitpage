import { mountTagEntityContainer } from "../features/tags/mount.ts";
import {
  prompterIsOpen,
  prompterSkipsShot,
  setPrompterOpen,
  setPrompterPlayingFlag,
  setVoiceFollowing,
  voiceIsFollowing
} from "../application/prompter-state.ts";
import { S } from "./_state.js";
import { writePref } from "./00p-prefs.js";
import { serverHomeId } from "./_home.js";
import { SpeechRecognitionCtor } from "./00-prelude.js";
import { rowSeconds } from "./01-scene-status.js";
import { hideShotScenes } from "./01b-hide-shot.js";
import { closeAllSidePanels } from "./03b-side-panels.js";
import {
  addPersonForTag,
  renderProduction,
  saveTagRename,
  setTagNotes,
  setTagOwner
} from "./08-production-panels.js";
import { showToast } from "./12-dirty-toast.js";
import { reviewBlocked, reviewMode } from "./13-hosted.js";
import { queueAutoSave } from "./14-export.js";
import { adoptProjectState, parseProjectFileState } from "./18-local-files.js";
import { ONBOARD_KEY } from "./20b-onboarding.js";
import {
  canOpenPrompterInBrowser,
  createDesktopRecognition,
  desktopVoiceAvailable,
  desktopVoiceKnown,
  loadDesktopVoice,
  openPrompterInBrowser
} from "./20f-desktop.js";
import { closeNewTabPage } from "./20j-newtab.js";
import { createRelayRecognition, hasVoiceRelay, setVoiceRelay } from "./_voice-relay.js";
import { pad2, formatTimecode } from "../core/production/timing.ts";
import { withoutCues } from "../core/text/cues.ts";
import { sliceCell } from "../core/text/edits.ts";
import { toHtml } from "../core/text/html.ts";
import { toPlainText } from "../core/text/projections.ts";
import { projection } from "../core/text/runs.ts";
import { cellOf } from "../legacy/richtext.ts";
import { focusMemory } from "../legacy/editor-bridge.ts";
import { setTagAddingPerson, setTagRenaming } from "../application/tag-panel-state.ts";

export var prompterMirror;
export var prompterFlip;
export var promptSceneMode;

var prompterSpeed = 42;
var prompterRAF = null;
var prompterLastTs = null;
var recognition = null;
var voiceStarting = false;
var promptWords = [];
var wordCursor = -1;
var speakable = [];
var speakNorms = [];
var speakCursor = -1;
var voiceRestarts = 0;
var voiceSession = 0;
var voiceStream = null;
var finalTranscript = "";
var interimTranscript = "";

function normalizeWord(w) {
  return String(w || "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

export function prompterSceneHtml(cell) {
  var words = 0;
  var html = toHtml(cell, {
    textHtml: function (text, esc, where) {
      if (where && where.dir) return esc(text);
      return text.split(/(\s+)/).map(function (part) {
        if (!part) return "";
        if (/^\s+$/.test(part)) return esc(part);
        words++;
        return '<span class="w">' + esc(part) + "</span>";
      }).join("");
    }
  });
  return { html: html, words: words };
}

export function trimPrompterCell(cell) {
  var p = projection(cell);
  var lead = p.length - p.replace(/^[^\S\u00a0]+/, "").length;
  var tail = p.length - p.replace(/[^\S\u00a0]+$/, "").length;
  return lead + tail >= p.length ? [] : sliceCell(cell, lead, p.length - tail);
}

var SENTENCE_END_RE = /[.!?]["'’”)\]]*$/;

export function buildPrompterContent() {
  var skippingShot = prompterSkipsShot() || hideShotScenes;
  var source = skippingShot
    ? S.state.rows.filter(function (row) { return row.status !== "shot"; })
    : S.state.rows;
  var sceneEntries = source.map(function (row) {
    var cell = trimPrompterCell(withoutCues(cellOf(row.audioText)));
    return { id: row.id, cell: cell, view: cell.length ? prompterSceneHtml(cell) : null };
  });
  var lines = sceneEntries.filter(function (e) { return e.view; });

  var paragraphs = [];
  lines.forEach(function (e, i) {
    var prevEndsSentence = i === 0 || SENTENCE_END_RE.test(toPlainText(lines[i - 1].cell));
    if (prevEndsSentence) paragraphs.push(e.view.html);
    else paragraphs[paragraphs.length - 1] += " " + e.view.html;
  });

  var content = document.getElementById("prompter-content");
  if (!paragraphs.length) {
    content.innerHTML = '<div class="prompter-empty">' + (skippingShot
      ? "Every scene is marked Shot — switch off Skip shot (or Hide shot scenes) to read them again."
      : "Nothing to read yet — add some audio text first.") + '</div>';
    promptWords = [];
  } else {
    content.innerHTML = paragraphs.map(function (html) {
      return '<div class="prompter-line">' + html + '</div>';
    }).join("");
    promptWords = Array.prototype.map.call(content.querySelectorAll(".w"), function (el) {
      return { el: el, norm: normalizeWord(el.textContent) };
    });
  }
  speakable = [];
  speakNorms = [];
  promptWords.forEach(function (w, i) {
    if (!w.norm) return;
    speakable.push(i);
    speakNorms.push(w.norm);
  });
  wordCursor = -1;
  speakCursor = -1;

  sceneRowIds = [];
  sceneWordStart = [];
  sceneWordEnd = [];
  var cursor = 0;
  sceneEntries.forEach(function (e) {
    var n = e.view ? e.view.words : 0;
    sceneRowIds.push(e.id);
    sceneWordStart.push(cursor);
    cursor += n;
    sceneWordEnd.push(cursor);
  });
  promptSceneIndex = -1;
  promptSceneEndWordOffset = null;

  sceneSeconds = [];
  sceneStartSec = [];
  var t = 0;
  source.forEach(function (row) {
    var secs = rowSeconds(row);
    sceneStartSec.push(t);
    sceneSeconds.push(secs);
    t += secs;
  });
  promptTotalSec = t;
  renderPrompterRundown();
  var skip = document.getElementById("pp-skip-shot");
  if (skip) skip.setAttribute("aria-pressed", prompterSkipsShot() ? "true" : "false");
}

var sceneSeconds = [];
var sceneStartSec = [];
var promptTotalSec = 0;
var rundownBlockEls = [];
var rundownBlockIndex = [];
var paintedScene = -2;
var promptLinePx = 60 * 1.42;

function renderPrompterRundown() {
  var track = document.getElementById("pp-rd-track");
  if (!track) return;
  var html = "";
  var count = 0;
  rundownBlockIndex = sceneSeconds.map(function (secs) {
    var before = count;
    if (secs > 0) {
      html += '<span class="pp-rd-block" style="flex-grow:' + Math.round(secs * 1000) / 1000 + '"></span>';
      count++;
    }
    return before;
  });
  track.innerHTML = count ? html + '<span class="pp-rd-head" aria-hidden="true"></span>' : "";
  track.style.setProperty("--pp-blocks", String(count));
  var els = track.querySelectorAll(".pp-rd-block");
  rundownBlockEls = sceneSeconds.map(function (secs, i) {
    return secs > 0 ? els[rundownBlockIndex[i]] : null;
  });
  paintedScene = -2;
}

function readingPosition(scroller) {
  var words = promptWords;
  var n = words.length;
  if (!n) return 0;
  var guide = scroller.scrollTop + scroller.clientHeight / 2;
  var lo = 0, hi = n - 1, last = -1, mid;
  while (lo <= hi) {
    mid = (lo + hi) >> 1;
    if (words[mid].el.offsetTop <= guide + 0.5) { last = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (last === -1) return 0;
  var top = words[last].el.offsetTop;
  lo = 0; hi = last;
  while (lo < hi) {
    mid = (lo + hi) >> 1;
    if (words[mid].el.offsetTop >= top - promptLinePx / 2) hi = mid; else lo = mid + 1;
  }
  var next = last + 1;
  var nextTop = next < n ? words[next].el.offsetTop : top + promptLinePx;
  var frac = nextTop > top ? Math.min(1, Math.max(0, (guide - top) / (nextTop - top))) : 0;
  return lo + frac * (next - lo);
}

function sceneAtWord(pos) {
  var w = Math.min(Math.floor(pos), promptWords.length - 1);
  var lo = 0, hi = sceneWordEnd.length - 1;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (sceneWordEnd[mid] > w) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

export function updatePrompterStatus() {
  if (!prompterIsOpen()) return;
  var scroller = document.getElementById("prompter-scroll");
  var scene = -1, elapsed = 0;
  if (promptWords.length && sceneRowIds.length) {
    var pos = readingPosition(scroller);
    scene = sceneAtWord(pos);
    var span = sceneWordEnd[scene] - sceneWordStart[scene];
    var into = span > 0 ? Math.min(1, Math.max(0, (pos - sceneWordStart[scene]) / span)) : 0;
    elapsed = sceneStartSec[scene] + sceneSeconds[scene] * into;
  }

  var posEl = document.getElementById("pp-scene-pos");
  setText(posEl, scene === -1 ? "" : pad2(scene + 1) + " / " + pad2(sceneRowIds.length));
  setText(document.getElementById("pp-scene-pos-sr"), scene === -1 ? "" : "Scene " + (scene + 1) + " of " + sceneRowIds.length);
  setText(document.getElementById("pp-scene-start"), scene === -1 ? "" : formatTimecode(sceneStartSec[scene]));
  var read = Math.round(elapsed);
  var total = Math.round(promptTotalSec);
  var readText = formatTimecode(read);
  var leftText = formatTimecode(Math.max(0, total - read));
  setText(document.getElementById("pp-elapsed"), readText);
  setText(document.getElementById("pp-remaining"), "−" + leftText);
  var clock = document.getElementById("pp-clock");
  if (clock) clock.setAttribute("aria-label", "Elapsed " + readText + ", " + leftText + " left");
  var bar = document.getElementById("pp-rundown");
  if (bar) {
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(Math.min(read, total)));
    bar.setAttribute("aria-valuetext", readText + " of " + formatTimecode(total));
  }

  var track = document.getElementById("pp-rd-track");
  if (!track || !promptTotalSec) return;
  if (scene !== paintedScene) {
    rundownBlockEls.forEach(function (el, i) {
      if (!el) return;
      el.classList.toggle("is-played", i < scene);
      el.classList.toggle("is-current", i === scene);
    });
    paintedScene = scene;
  }
  var cur = scene === -1 ? null : rundownBlockEls[scene];
  if (cur) cur.style.setProperty("--p", (sceneSeconds[scene] ? (elapsed - sceneStartSec[scene]) / sceneSeconds[scene] * 100 : 0) + "%");
  track.style.setProperty("--pp-at", String(Math.min(1, elapsed / promptTotalSec)));
  track.style.setProperty("--pp-i", String(scene === -1 ? 0 : rundownBlockIndex[scene]));
}

var prompterWakeLock = null;
var wakeLockGen = 0;

export function acquireWakeLock(owns) {
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  var gen = ++wakeLockGen;
  navigator.wakeLock.request("screen").then(function (lock) {
    if (gen !== wakeLockGen || !prompterIsOpen() || (owns && !owns())) { lock.release().catch(function () {}); return; }
    prompterWakeLock = lock;
  }).catch(function () { });
}

function releaseWakeLock() {
  wakeLockGen++;
  if (prompterWakeLock) {
    prompterWakeLock.release().catch(function () {});
    prompterWakeLock = null;
  }
}

export function disposePrompterView() {
  setPrompterPlaying(false);
  stopVoiceFollow();
  releaseWakeLock();
}

var PROMPTER_MIRROR_KEY = "splitpage-prompter-mirror";
var PROMPTER_FLIP_KEY = "splitpage-prompter-flip";

function readPrompterOrientationFlag(key) {
  try { return localStorage.getItem(key) === "1"; } catch (e) { return false; }
}
function writePrompterOrientationFlag(key, on) {
  writePref(key, on ? "1" : "0");
}

function applyPrompterOrientation() {
  var scroller = document.getElementById("prompter-scroll");
  scroller.classList.toggle("mirror", prompterMirror);
  scroller.classList.toggle("flip", prompterFlip);
  var prompter = document.getElementById("prompter");
  prompter.classList.toggle("pp-mirrored", prompterMirror);
  prompter.classList.toggle("pp-flipped", prompterFlip);
  setToggle(document.getElementById("pp-mirror"), prompterMirror);
  setToggle(document.getElementById("pp-flip"), prompterFlip);
}

function setToggle(btn, on) {
  if (!btn) return;
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

export function setPrompterMirror(on) {
  prompterMirror = on;
  writePrompterOrientationFlag(PROMPTER_MIRROR_KEY, on);
  applyPrompterOrientation();
}
export function setPrompterFlip(on) {
  prompterFlip = on;
  writePrompterOrientationFlag(PROMPTER_FLIP_KEY, on);
  applyPrompterOrientation();
}

var PROMPTER_SCENE_MODE_KEY = "splitpage-prompter-scene-mode";
var sceneRowIds = [];
var sceneWordStart = [];
var sceneWordEnd = [];
var promptSceneIndex = -1;
var promptSceneEndWordOffset = null;
var promptSceneGuideOffset = 0;

function scenePastReadingLine(scrollTop, wordTop, guideTop) {
  return (wordTop - scrollTop) <= guideTop;
}

export function updateSceneReadout() {
  var el = document.getElementById("pp-scene-readout");
  if (!el) return;
  if (!promptSceneMode || promptSceneIndex === -1 || !sceneRowIds.length) { el.textContent = ""; return; }
  el.textContent = "Scene " + (promptSceneIndex + 1) + " of " + sceneRowIds.length;
}

function updatePrompterSceneModeUI() {
  setToggle(document.getElementById("pp-scene-mode"), promptSceneMode);
  ["pp-scene-step", "pp-scene-prev", "pp-scene-next", "pp-scene-readout"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.hidden = !promptSceneMode;
  });
  updateSceneReadout();
}

function findNonEmptySceneIndex(from, dir) {
  for (var i = from; i >= 0 && i < sceneRowIds.length; i += dir) {
    if (sceneWordEnd[i] > sceneWordStart[i]) return i;
  }
  return -1;
}

function cueScene(idx) {
  if (idx < 0 || idx >= sceneRowIds.length) return false;
  if (sceneWordEnd[idx] <= sceneWordStart[idx]) return false;
  var scroller = document.getElementById("prompter-scroll");
  var firstWord = promptWords[sceneWordStart[idx]].el;
  var lastWord = promptWords[sceneWordEnd[idx] - 1].el;
  promptSceneIndex = idx;
  promptSceneGuideOffset = scroller.clientHeight / 2;
  scroller.scrollTop = Math.max(0, firstWord.offsetTop - promptSceneGuideOffset);
  promptSceneEndWordOffset = lastWord.offsetTop;
  updateSceneReadout();
  updatePrompterStatus();
  return true;
}

export function stepScene(dir) {
  if (!promptSceneMode || !sceneRowIds.length) return;
  var next = findNonEmptySceneIndex(promptSceneIndex + dir, dir);
  if (next === -1) return;
  setPrompterPlaying(false);
  cueScene(next);
}

export function cueSceneForCurrentPosition() {
  if (!sceneRowIds.length) { promptSceneIndex = -1; promptSceneEndWordOffset = null; updateSceneReadout(); return; }
  var lastRow = focusMemory().lastRow();
  var idx = lastRow ? sceneRowIds.indexOf(lastRow) : -1;
  if (idx === -1) idx = 0;
  var resolved = findNonEmptySceneIndex(idx, 1);
  if (resolved === -1) resolved = findNonEmptySceneIndex(idx, -1);
  if (resolved === -1) { promptSceneIndex = -1; promptSceneEndWordOffset = null; updateSceneReadout(); return; }
  cueScene(resolved);
}

function advanceSceneAfterAutoPause() {
  var next = findNonEmptySceneIndex(promptSceneIndex + 1, 1);
  if (next === -1) { promptSceneEndWordOffset = null; return; }
  promptSceneIndex = next;
  promptSceneEndWordOffset = promptWords[sceneWordEnd[next] - 1].el.offsetTop;
  updateSceneReadout();
}

export function setPrompterSceneMode(on) {
  on = !!on;
  if (on === promptSceneMode) return;
  promptSceneMode = on;
  writePrompterOrientationFlag(PROMPTER_SCENE_MODE_KEY, on);
  updatePrompterSceneModeUI();
  if (on) cueSceneForCurrentPosition();
  else { promptSceneIndex = -1; promptSceneEndWordOffset = null; }
}

var prompterLeaveSeq = 0;

function lockPageScrollWhenArrived(el) {
  var lock = function () { if (prompterIsOpen()) document.body.classList.add("prompter-open"); };
  var arriving = el.getAnimations ? el.getAnimations().filter(function (a) {
    return a.effect && a.effect.target === el;
  }) : [];
  if (!arriving.length) { lock(); return; }
  Promise.all(arriving.map(function (a) { return a.finished; })).then(lock, function () {});
}

export function openPrompter() {
  closeAllSidePanels();
  buildPrompterContent();
  var el = document.getElementById("prompter");
  prompterLeaveSeq++;
  el.classList.remove("is-holding");
  el.inert = false;
  el.hidden = false;
  setPrompterOpen(true);
  lockPageScrollWhenArrived(el);
  document.getElementById("prompter-scroll").scrollTop = 0;
  setPrompterPlaying(false);
  applyPrompterDefaultSize();
  applyPrompterSize();
  applyPrompterOrientation();
  updatePrompterSceneModeUI();
  if (promptSceneMode) cueSceneForCurrentPosition();
  updateVoiceAvailability();
  syncSpeedReadout();
  updatePrompterStatus();
  acquireWakeLock();
}

export function closePrompter() {
  setPrompterPlaying(false);
  stopVoiceFollow();
  setPrompterOpen(false);
  releaseWakeLock();
  var el = document.getElementById("prompter");
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.inert = true;
  var seq = ++prompterLeaveSeq;
  if (document.fullscreenElement) {
    el.classList.add("is-holding");
    var fade = function () { if (seq === prompterLeaveSeq) el.classList.remove("is-holding"); };
    document.exitFullscreen().then(fade, fade);
    setTimeout(fade, 1000);
  }
  el.hidden = true;
  document.body.classList.remove("prompter-open");
}

export function setPrompterPlaying(on) {
  if (on && voiceIsFollowing()) stopVoiceFollow();
  setPrompterPlayingFlag(on);
  var btn = document.getElementById("pp-play");
  var icon = btn.querySelector("use");
  var label = btn.querySelector(".pp-sr");
  if (icon) icon.setAttribute("href", on ? "#i-pause" : "#i-play");
  if (label) label.textContent = on ? "Pause" : "Play";
  else btn.textContent = on ? "Pause" : "Play";
  btn.classList.toggle("is-active", on);
  if (on) {
    prompterLastTs = null;
    prompterRAF = requestAnimationFrame(prompterTick);
  } else if (prompterRAF) {
    cancelAnimationFrame(prompterRAF);
    prompterRAF = null;
  }
}

function prompterTick(ts) {
  var scroller = document.getElementById("prompter-scroll");
  if (prompterLastTs == null) prompterLastTs = ts;
  var dt = (ts - prompterLastTs) / 1000;
  prompterLastTs = ts;
  scroller.scrollTop += prompterSpeed * dt;
  if (promptSceneMode && promptSceneEndWordOffset != null &&
      scenePastReadingLine(scroller.scrollTop, promptSceneEndWordOffset, promptSceneGuideOffset)) {
    setPrompterPlaying(false);
    advanceSceneAfterAutoPause();
    return;
  }
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    setPrompterPlaying(false);
    return;
  }
  prompterRAF = requestAnimationFrame(prompterTick);
}

export function applyPrompterSize() {
  var size = Number(document.getElementById("pp-size").value);
  document.getElementById("prompter").style.setProperty("--pp-size", size + "px");
  promptLinePx = size * 1.42;
  setText(document.getElementById("pp-size-value"), String(size));
  updatePrompterStatus();
}

var PROMPTER_SIZE_DEFAULT = 60;
var PROMPTER_SIZE_PHONE = 36;
var promptSizeDefaultSet = null;

function applyPrompterDefaultSize() {
  var input = document.getElementById("pp-size");
  if (promptSizeDefaultSet !== null && Number(input.value) !== promptSizeDefaultSet) return;
  var phone = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
  promptSizeDefaultSet = phone ? PROMPTER_SIZE_PHONE : PROMPTER_SIZE_DEFAULT;
  input.value = String(promptSizeDefaultSet);
}

var PROMPTER_SIZE_STEP = 4;

export function stepPrompterSize(dir) {
  var input = document.getElementById("pp-size");
  var next = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + dir * PROMPTER_SIZE_STEP));
  input.value = String(next);
  applyPrompterSize();
}

var PROMPTER_SPEED_STEP = 6;
var PROMPTER_SPEED_BASE = 42;

export function setPrompterSpeed(value) {
  var input = document.getElementById("pp-speed");
  prompterSpeed = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(value)));
  input.value = String(prompterSpeed);
  syncSpeedReadout();
}

export function stepPrompterSpeed(dir) {
  setPrompterSpeed(prompterSpeed + dir * PROMPTER_SPEED_STEP);
}

function syncSpeedReadout() {
  setText(document.getElementById("pp-speed-value"), (prompterSpeed / PROMPTER_SPEED_BASE).toFixed(1) + "×");
}

function setVoiceStatus(msg, kind) {
  var el = document.getElementById("pp-voice-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "pp-voice-status" + (kind ? " " + kind : "");
  syncVoiceState();
}

function syncVoiceState() {
  var group = document.getElementById("pp-voice-state");
  var el = document.getElementById("pp-voice-status");
  if (!group || !el) return;
  group.classList.toggle("is-live", !!voiceIsFollowing());
  group.classList.toggle("has-msg", !!el.textContent);
}

function setVoiceLabel(btn, text) {
  var label = btn.querySelector(".pp-voice-label");
  if (label) label.textContent = text;
  else btn.textContent = text;
}

var voiceMicName = "";
function listeningStatus(fallback) {
  return voiceMicName ? "Listening — " + voiceMicName : fallback;
}

var VOICE_IDLE_LABEL = "Follow My Voice";
var VOICE_BROWSER_LABEL = "Open in browser to use Follow My Voice";
var VOICE_DESKTOP_UNAVAILABLE = "Follow My Voice isn't available in this desktop app — it works in the browser version.";

function desktopListens() {
  return !!S.DESKTOP && desktopVoiceAvailable();
}

function voiceIdleLabel() {
  if (S.DESKTOP && !desktopListens() && canOpenPrompterInBrowser()) return VOICE_BROWSER_LABEL;
  return VOICE_IDLE_LABEL;
}

export function updateVoiceAvailability() {
  var btn = document.getElementById("pp-voice");
  if (!btn) return;
  if (S.DESKTOP && !desktopVoiceKnown()) {
    btn.disabled = true;
    loadDesktopVoice().then(updateVoiceAvailability);
    return;
  }
  if (!voiceIsFollowing()) setVoiceLabel(btn, voiceIdleLabel());
  if (S.DESKTOP) {
    if (desktopListens()) {
      btn.disabled = false;
      if (!voiceIsFollowing() && !voiceStarting) setVoiceStatus("", "");
    } else if (canOpenPrompterInBrowser()) {
      btn.disabled = false;
      setVoiceStatus("Chrome or Edge can follow your voice — this opens the saved script there.", "");
    } else {
      btn.disabled = true;
      setVoiceStatus(VOICE_DESKTOP_UNAVAILABLE, "");
    }
  } else if (hasVoiceRelay()) {
    btn.disabled = false;
    if (!voiceIsFollowing() && !voiceStarting) setVoiceStatus("", "");
  } else if (!SpeechRecognitionCtor) {
    btn.disabled = true;
    setVoiceStatus("Voice follow needs Chrome or Edge.", "");
  } else if (!window.isSecureContext) {
    btn.disabled = true;
    setVoiceStatus("Voice follow needs the app served over http:// — start it with start.bat.", "");
  } else {
    btn.disabled = false;
    if (!voiceIsFollowing()) setVoiceStatus("", "");
  }
}

function updateVoiceButtonUI() {
  var btn = document.getElementById("pp-voice");
  if (!btn) return;
  btn.classList.toggle("is-active", voiceIsFollowing());
  setVoiceLabel(btn, voiceIsFollowing() ? "Stop Following" : voiceIdleLabel());
  var scroller = document.getElementById("prompter-scroll");
  if (scroller) scroller.classList.toggle("is-following", !!voiceIsFollowing());
  syncVoiceState();
}

function applySpokenUpTo(idx) {
  for (var i = 0; i < promptWords.length; i++) {
    var el = promptWords[i].el;
    el.classList.toggle("spoken", i < idx);
    el.classList.toggle("current-word", i === idx);
  }
}

function clearSpokenHighlights() {
  promptWords.forEach(function (w) {
    w.el.classList.remove("spoken");
    w.el.classList.remove("current-word");
  });
}

function scrollWordIntoView(idx) {
  var w = promptWords[idx];
  if (!w) return;
  var scroller = document.getElementById("prompter-scroll");
  scroller.scrollTo({ top: Math.max(0, w.el.offsetTop - scroller.clientHeight / 2), behavior: "smooth" });
}

function findBestMatch(recentWords, scriptNorms, searchStart, searchEnd) {
  var n = recentWords.length;
  var bestScore = 0, bestIndex = -1;
  for (var end = searchStart; end <= searchEnd; end++) {
    var score = 0;
    for (var k = 1; k <= n && (end - k + 1) >= 0; k++) {
      if (scriptNorms[end - k + 1] === recentWords[n - k]) score++;
      else break;
    }
    if (score > bestScore) { bestScore = score; bestIndex = end; }
  }
  return { index: bestIndex, score: bestScore };
}

function onSpeechTranscript() {
  var combined = (finalTranscript + " " + interimTranscript).trim();
  var words = combined.split(/\s+/).map(normalizeWord).filter(Boolean);
  var recent = words.slice(-8);
  if (!recent.length || !speakNorms.length) return;

  var searchStart = Math.max(0, speakCursor - 40);
  var searchEnd = Math.min(speakNorms.length - 1, speakCursor + 80);
  var best = findBestMatch(recent, speakNorms, searchStart, searchEnd);

  if (best.index !== -1 && best.index !== speakCursor &&
      best.score >= (best.index > speakCursor ? 2 : 3)) {
    speakCursor = best.index;
    wordCursor = speakable[speakCursor];
    applySpokenUpTo(wordCursor);
    scrollWordIntoView(wordCursor);
    if (promptSceneMode && promptSceneIndex !== -1 && wordCursor >= sceneWordEnd[promptSceneIndex]) {
      stopVoiceFollow();
      advanceSceneAfterAutoPause();
      setVoiceStatus("Scene finished — say it again to keep following, or press Next.", "listening");
    }
  }

  if (finalTranscript.length > 4000) finalTranscript = finalTranscript.slice(-1200);

  if (speakCursor >= speakNorms.length - 1) {
    setVoiceStatus("Reached the end", "listening");
  } else if (voiceIsFollowing()) {
    setVoiceStatus(listeningStatus("Listening"), "listening");
  }
}

function releaseVoiceStream() {
  if (!voiceStream) return;
  try { voiceStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  voiceStream = null;
}

var DESKTOP_VOICE_WARNINGS = {
  "no-signal": function () {
    return "Windows isn't hearing " + (voiceMicName || "the microphone") +
      " — check it's plugged in, and that Settings › Privacy & security › Microphone lets desktop apps use it.";
  },
  "too-quiet": function () {
    return "Speak up a little, or move closer to " + (voiceMicName || "the microphone") + ".";
  },
  "too-noisy": function () {
    return "It's noisy here — Follow My Voice may lose its place.";
  },
  "blocked-all": function () {
    return "Windows is blocking apps from using the microphone — turn on Settings › Privacy & security › Microphone.";
  },
  "blocked-desktop": function () {
    return "Windows is blocking desktop apps from using the microphone — turn on Settings › Privacy & security › Microphone › Let desktop apps access your microphone.";
  }
};
var CLEARABLE_VOICE_WARNINGS = ["no-signal", "too-quiet", "blocked-all", "blocked-desktop"];

export async function startVoiceFollow() {
  var desktop = !!S.DESKTOP;
  if (desktop && !desktopVoiceKnown()) await loadDesktopVoice();
  if (desktop && !desktopListens()) {
    if (!canOpenPrompterInBrowser()) { setVoiceStatus(VOICE_DESKTOP_UNAVAILABLE, ""); return; }
    setVoiceStatus("Opening in your browser…", "");
    openPrompterInBrowser().then(function (result) {
      if (result && result.message) setVoiceStatus(result.message, result.ok ? "" : "error");
    });
    return;
  }
  var relayed = !desktop && hasVoiceRelay();
  if (!desktop && !relayed && !SpeechRecognitionCtor) return;
  if (voiceIsFollowing() || voiceStarting) return;
  if (!speakNorms.length) {
    setVoiceStatus("Nothing to read yet.", "error");
    return;
  }
  voiceStarting = true;
  var mySession = ++voiceSession;
  setPrompterPlaying(false);
  finalTranscript = "";
  interimTranscript = "";
  wordCursor = -1;
  speakCursor = -1;
  voiceRestarts = 0;
  voiceMicName = "";
  clearSpokenHighlights();

  if (!desktop && !relayed && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    setVoiceStatus("Asking for the microphone…", "");
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      voiceStarting = false;
      var name = err && err.name;
      setVoiceStatus(
        name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No microphone was found."
          : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.",
        "error");
      return;
    }
    if (mySession !== voiceSession) { releaseVoiceStream(); voiceStarting = false; return; }
    try {
      var track = voiceStream.getAudioTracks()[0];
      voiceMicName = (track && track.label) || "";
    } catch (e) {}
  }

  try {
    recognition = desktop ? createDesktopRecognition()
      : relayed ? createRelayRecognition()
      : new SpeechRecognitionCtor();
  } catch (e) {
    voiceStarting = false;
    releaseVoiceStream();
    setVoiceStatus("Could not start speech recognition.", "error");
    return;
  }
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  if (desktop || relayed) {
    setVoiceStatus(relayed ? "Starting speech recognition in the Splitpage desktop app…" : "Starting Windows speech recognition…", "");
    recognition.onwarning = function (e) {
      if (e && e.warning === "clear") {
        var el = document.getElementById("pp-voice-status");
        if (voiceIsFollowing() && el) {
          for (var i = 0; i < CLEARABLE_VOICE_WARNINGS.length; i++) {
            if (el.textContent === DESKTOP_VOICE_WARNINGS[CLEARABLE_VOICE_WARNINGS[i]]()) {
              setVoiceStatus(listeningStatus("Listening…"), "listening");
              break;
            }
          }
        }
        return;
      }
      var warn = DESKTOP_VOICE_WARNINGS[e && e.warning];
      if (warn && voiceIsFollowing()) setVoiceStatus(warn(), "error");
    };
    recognition.ondevice = function (e) {
      if (mySession !== voiceSession) return;
      voiceMicName = (e && typeof e.name === "string") ? e.name : "";
    };
  }
  recognition.onstart = function () {
    voiceStarting = false;
    setVoiceFollowing(true);
    updateVoiceButtonUI();
    setVoiceStatus(listeningStatus("Listening…"), "listening");
  };
  recognition.onresult = function (e) {
    var finalChunk = "", interimChunk = "";
    for (var i = e.resultIndex; i < e.results.length; i++) {
      var r = e.results[i];
      if (r.isFinal) finalChunk += r[0].transcript + " ";
      else interimChunk += r[0].transcript + " ";
    }
    if (finalChunk) finalTranscript += finalChunk;
    interimTranscript = interimChunk;
    voiceRestarts = 0;
    onSpeechTranscript();
  };
  recognition.onerror = function (e) {
    voiceStarting = false;
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setVoiceStatus(desktop || relayed
        ? "Microphone blocked — let desktop apps use it in Settings › Privacy & security › Microphone, then try again."
        : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.", "error");
      setVoiceFollowing(false);
    } else if (e.error === "no-recognizer") {
      setVoiceStatus("Windows has no speech recogniser installed. Add one in Settings › Time & language › Speech, or use Present in Browser.", "error");
      setVoiceFollowing(false);
    } else if (e.error === "taken") {
      setVoiceStatus("Another tab is following your voice now.", "");
      setVoiceFollowing(false);
    } else if (e.error === "helper-failed" || e.error === "unavailable") {
      setVoiceStatus("Windows speech recognition couldn't start. Present in Browser still works.", "error");
      setVoiceFollowing(false);
    } else if (e.error === "relay-lost") {
      setVoiceStatus("Lost the Splitpage desktop app — open the teleprompter from it again to follow your voice.", "error");
      setVoiceFollowing(false);
    } else if (e.error === "audio-capture") {
      setVoiceStatus("No microphone was found.", "error");
      setVoiceFollowing(false);
    } else if (e.error === "network") {
      setVoiceStatus("Speech recognition needs an internet connection.", "error");
    } else {
      setVoiceStatus("Voice follow hit an error (" + e.error + ").", "error");
    }
    updateVoiceButtonUI();
  };
  recognition.onend = function () {
    if (mySession !== voiceSession || !voiceIsFollowing()) {
      if (mySession === voiceSession) releaseVoiceStream();
      updateVoiceButtonUI();
      return;
    }
    voiceRestarts++;
    if (voiceRestarts > 40) {
      setVoiceFollowing(false);
      releaseVoiceStream();
      updateVoiceButtonUI();
      setVoiceStatus("Voice follow kept dropping out — stopped.", "error");
      return;
    }
    setTimeout(function () {
      if (mySession !== voiceSession || !voiceIsFollowing() || !recognition) return;
      try { recognition.start(); }
      catch (e) {
        setVoiceFollowing(false);
        recognition = null;
        releaseVoiceStream();
        updateVoiceButtonUI();
      }
    }, Math.min(2000, 150 * voiceRestarts));
  };
  try {
    recognition.start();
  } catch (e) {
    voiceStarting = false;
    releaseVoiceStream();
    setVoiceStatus("Could not start speech recognition.", "error");
  }
}

export function stopVoiceFollow() {
  var wasActive = voiceIsFollowing();
  voiceSession++;
  setVoiceFollowing(false);
  voiceStarting = false;
  if (recognition) {
    try { recognition.onend = null; recognition.onresult = null; recognition.stop(); } catch (e) {}
    recognition = null;
  }
  releaseVoiceStream();
  updateVoiceButtonUI();
  if (wasActive) setVoiceStatus("", "");
}

var PROMPTER_LAUNCH_KEY = "splitpage-prompter-launch";
var PROMPTER_TOKEN_RE = /^[0-9a-f]{64}$/;
var HOSTED_LAUNCH_WAIT_MS = 5 * 60 * 1000;

function readPrompterLaunch() {
  if (S.DESKTOP) return null;
  var wanted;
  try { wanted = new URLSearchParams(location.search).get("teleprompter") === "1"; } catch (e) { wanted = false; }
  var m = /(?:^#|&)script=([0-9a-f]{64})(?=&|$)/.exec(location.hash || "");
  var token = m ? m[1] : "";
  var v = /(?:^#|&)voice=(\d{1,5}-[0-9a-f]{64})(?=&|$)/.exec(location.hash || "");
  if (wanted || token) setVoiceRelay(v ? v[1] : "");
  else setVoiceRelay(null);
  if (wanted || token) {
    try {
      var url = new URL(location.href);
      url.searchParams.delete("teleprompter");
      var rest = (url.hash || "").replace(/(^#|&)script=[0-9a-f]{64}/, "$1").replace(/^#&/, "#")
        .replace(/(^#|&)voice=\d{1,5}-[0-9a-f]{64}/, "$1").replace(/^#&/, "#");
      if (rest === "#") rest = "";
      history.replaceState(null, "", url.pathname + url.search + rest);
    } catch (e) { }
  }
  if (token) {
    try { sessionStorage.setItem(PROMPTER_LAUNCH_KEY, token); } catch (e) { }
    return { token: token };
  }
  if (wanted) return { hosted: true };
  var kept;
  try { kept = sessionStorage.getItem(PROMPTER_LAUNCH_KEY) || ""; } catch (e) { kept = ""; }
  return PROMPTER_TOKEN_RE.test(kept) ? { token: kept } : null;
}

function whenInitialStateReady() {
  return new Promise(function (resolve) {
    (function check() {
      if (S.initialStateReady) S.initialStateReady.then(resolve, resolve);
      else setTimeout(check, 50);
    })();
  });
}

function showPrompterForLaunch() {
  closeNewTabPage();
  if (!prompterIsOpen()) openPrompter();
}

async function launchPrompterFromScript(token) {
  var body = null;
  try {
    var res = await fetch("prompter-script/" + token, { cache: "no-store", credentials: "same-origin" });
    if (res.ok) body = await res.json();
  } catch (e) { body = null; }
  if (!body || typeof body.name !== "string" || typeof body.text !== "string") {
    try { sessionStorage.removeItem(PROMPTER_LAUNCH_KEY); } catch (e) {}
    showToast("This teleprompter link has expired — open it again from the Splitpage desktop app " +
              "(File ▸ Present in browser).", "warn", true);
    return false;
  }
  var file = new File([body.text], body.name, { type: "text/plain" });
  var parsed = await parseProjectFileState(file);
  if (!parsed || parsed.error) {
    showToast("Could not read the script the desktop app sent.", "error", true);
    return false;
  }
  adoptProjectState(parsed.state, file, null, parsed.kind, { skipSnapshot: true, silent: true });
  showPrompterForLaunch();
  showToast("A copy from the desktop app, for reading — edit the script there; changes made here are not saved back.", "ok");
  return true;
}

function launchPrompterForServerDoc() {
  var deadline = Date.now() + HOSTED_LAUNCH_WAIT_MS;
  (function check() {
    if (serverHomeId()) { showPrompterForLaunch(); return; }
    if (Date.now() < deadline) setTimeout(check, 250);
  })();
}

function startPrompterLaunch(launch) {
  try {
    if (!localStorage.getItem(ONBOARD_KEY)) {
      localStorage.setItem(ONBOARD_KEY, JSON.stringify({ v: 1, done: true, skipped: true, at: "prompter-launch" }));
    }
  } catch (e) { }
  whenInitialStateReady().then(function () {
    if (launch.token) return launchPrompterFromScript(launch.token);
    launchPrompterForServerDoc();
  });
}

export function wireTagEntityContainer(id, rootClick) {
  return mountTagEntityContainer({
    window: window,
    id: id,
    ports: {
      rootClick: rootClick,
      reviewMode: reviewMode,
      reviewBlocked: reviewBlocked,
      renderProduction: renderProduction,
      saveTagRename: saveTagRename,
      addPersonForTag: addPersonForTag,
      setRenaming: function (value) { setTagRenaming(value); },
      setAddingPerson: function (value) { setTagAddingPerson(value); },
      setTagOwner: setTagOwner,
      setTagNotes: setTagNotes,
      queueAutoSave: queueAutoSave
    }
  });
}

export function __init() {
  prompterMirror = readPrompterOrientationFlag(PROMPTER_MIRROR_KEY);

  prompterFlip = readPrompterOrientationFlag(PROMPTER_FLIP_KEY);

  promptSceneMode = readPrompterOrientationFlag(PROMPTER_SCENE_MODE_KEY);

  window.__prompterTest = {
    checkSceneBoundaryNow: function () {
      var scroller = document.getElementById("prompter-scroll");
      if (!promptSceneMode || promptSceneEndWordOffset == null) return false;
      if (!scenePastReadingLine(scroller.scrollTop, promptSceneEndWordOffset, promptSceneGuideOffset)) return false;
      setPrompterPlaying(false);
      advanceSceneAfterAutoPause();
      return true;
    },
    simulateVoiceWordCursor: function (idx) {
      wordCursor = idx;
      if (!promptSceneMode || promptSceneIndex === -1 || wordCursor < sceneWordEnd[promptSceneIndex]) return false;
      stopVoiceFollow();
      advanceSceneAfterAutoPause();
      return true;
    },
    launchFromScript: launchPrompterFromScript,
    updateStatus: updatePrompterStatus
  };

  var launch = readPrompterLaunch();
  if (launch) startPrompterLaunch(launch);
}
