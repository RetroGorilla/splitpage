import { S } from "./_state.js";
import { serverHomeId } from "./_home.js";
import { SpeechRecognitionCtor } from "./00-prelude.js";
import { hideShotScenes } from "./01b-hide-shot.js";
import { cellOf, projection, sliceCell, toHtml, toPlainText } from "./04c-doc-model.js";
import {
  addPersonForTag,
  renderProduction,
  saveTagRename,
  setTagNotes,
  setTagOwner
} from "./08-production-panels.js";
import { showToast } from "./12-dirty-toast.js";
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
import { onRootClick } from "./21-events.js";

/* Declared here, assigned in __init() below: these initialisers read the
   DOM, read storage, or depend on another module's value, so they have to
   run in fragment order rather than in whatever order the bundle lands in. */
export var prompterMirror;
export var prompterFlip;
export var promptSceneMode;

/* ================= teleprompter ================= */

function normalizeWord(w) {
  return String(w || "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

/* One scene's words as the prompter shows them, read from the document
   model (#85) rather than by walking the cell's HTML: the cell's own
   markup, so tags, comments, links and formatting look as they do in the
   editor, with every word in a <span class="w"> — the unit voice follow
   and the reading line step through. Words are cut at whitespace within
   each stretch of text whose formatting, link, tag and comments are all
   the same, as they always were cut per text node: "bo<strong>ld</strong>"
   is two spans. (Two neighbouring elements of the SAME format, which the
   stored markup can hold, are one stretch now, so a word split between
   them is one span instead of two.) Nesting is the model's one order, not
   whatever the stored markup had; it looks the same. Returns the markup
   and how many words it holds. */
export function prompterSceneHtml(cell) {
  var words = 0;
  var html = toHtml(cell, {
    textHtml: function (text, esc) {
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

/* A scene's cell without the spaces and line breaks at either end, which
   would otherwise open or close its paragraph with an empty line. A
   no-break space stays, as it did when this was a regex over the stored
   HTML (which spells it "&nbsp;"): it is there because someone typed it. */
export function trimPrompterCell(cell) {
  var p = projection(cell);
  var lead = p.length - p.replace(/^[^\S\u00a0]+/, "").length;
  var tail = p.length - p.replace(/[^\S\u00a0]+$/, "").length;
  return lead + tail >= p.length ? [] : sliceCell(cell, lead, p.length - tail);
}

/* A trailing ., !, or ? (optionally tucked inside a closing quote/paren)
   reads as a finished thought — that row gets its own paragraph, with the
   usual breathing room before the next. Anything else (a trailing comma,
   or no punctuation at all — a sentence split across rows for editing
   convenience) flows straight into the next row instead, with no gap. */
var SENTENCE_END_RE = /[.!?]["'’”)\]]*$/;

export function buildPrompterContent() {
  /* On day two you only want what's left. Filtering here rather than
     hiding after the fact keeps the word index — and so voice follow —
     lined up with what is actually on screen. Two independent reasons to
     leave a Shot scene out: the prompter's own "Skip shot" toggle, and
     the app-wide "hide shot scenes" toggle (issue #25) — either one is
     enough. */
  var skippingShot = S.prompterSkipShot || hideShotScenes;
  var source = skippingShot
    ? S.state.rows.filter(function (row) { return row.status !== "shot"; })
    : S.state.rows;
  /* Every row (even a blank one) and its id — scene mode's boundaries are
     addressed by scene POSITION in this filtered list, the same list
     "Scene 4 of 12" counts against, so a scene with nothing to read still
     holds its place in the count even though stepScene() below will never
     stop on it. Each scene is rendered once, here: the words a scene
     counts for its boundaries are the very spans its paragraph shows, so
     the two can never disagree about what a "word" is. */
  var sceneEntries = source.map(function (row) {
    var cell = trimPrompterCell(cellOf(row.audioText));
    return { id: row.id, cell: cell, view: cell.length ? prompterSceneHtml(cell) : null };
  });
  var lines = sceneEntries.filter(function (e) { return e.view; });

  /* Scenes are glued into one paragraph with a space between, so no word
     ever runs on from one scene into the next. */
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
    S.promptWords = [];
  } else {
    content.innerHTML = paragraphs.map(function (html) {
      return '<div class="prompter-line">' + html + '</div>';
    }).join("");
    S.promptWords = Array.prototype.map.call(content.querySelectorAll(".w"), function (el) {
      return { el: el, norm: normalizeWord(el.textContent) };
    });
  }
  S.speakable = [];
  S.speakNorms = [];
  S.promptWords.forEach(function (w, i) {
    if (!w.norm) return;
    S.speakable.push(i);
    S.speakNorms.push(w.norm);
  });
  S.wordCursor = -1;
  S.speakCursor = -1;

  /* ---- scene mode boundaries (issue #26) ----
     sceneRowIds[i] is one entry of `source` (a scene, in its own document
     order — never renumbered by what got merged into what paragraph);
     [sceneWordStart[i], sceneWordEnd[i]) is that scene's half-open range
     of indexes into promptWords, in the SAME index space wordCursor and
     speakCursor already use. A blank scene gets a zero-width range —
     still counted in "Scene N of Total", never a place cueScene/stepScene
     will actually stop. */
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
}

/* A phone's screen dims and locks mid-read without this — fatal for a
   teleprompter. Best-effort: unsupported browsers just don't get it, and
   the OS revokes it on tab switch, so it is re-acquired on return. */
var prompterWakeLock = null;
/* Bumped on every acquire/release so a request's resolution can tell
   whether it is still the one that matters. request() is fire-and-forget
   with no cancellation token: the prompter can close (or visibilitychange
   can fire another acquire, which it does every time the tab regains
   focus while open) before it resolves, and releaseWakeLock() can only
   ever act on whatever is CURRENTLY in prompterWakeLock — a lock that
   lands after the fact, or a lock superseded by a newer request, used to
   just get silently stored over top with nothing left to release it,
   keeping the screen awake indefinitely. */
var wakeLockGen = 0;

export function acquireWakeLock() {
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  var gen = ++wakeLockGen;
  navigator.wakeLock.request("screen").then(function (lock) {
    if (gen !== wakeLockGen || !S.prompterOpen) { lock.release().catch(function () {}); return; }
    prompterWakeLock = lock;
  }).catch(function () { /* denied (low battery etc.) — nothing to do */ });
}

function releaseWakeLock() {
  wakeLockGen++;
  if (prompterWakeLock) {
    prompterWakeLock.release().catch(function () {});
    prompterWakeLock = null;
  }
}

/* ---------- mirror / flip ----------

   Which way a rig needs the picture turned is about the hardware sitting
   in front of the lens, not the script on screen — a beam-splitter glass
   (Mirror) or a monitor bolted in upside-down (Flip). So, like the
   writer's remembered text size, it lives in localStorage keyed to this
   device rather than travelling with the document: opening someone else's
   script on your rig should keep reading through *your* glass correctly,
   and opening your own script on a plain monitor shouldn't come out
   mirrored. Both flags only ever toggle a transform on #prompter-scroll
   (app.css) — the reading line and the controls are deliberately outside
   that element (see .prompter-viewport in page.html) so they never flip,
   and scrollTop keeps working in ordinary DOM space regardless: the
   transform only changes how that same scroll position is painted. */
var PROMPTER_MIRROR_KEY = "splitpage-prompter-mirror";
var PROMPTER_FLIP_KEY = "splitpage-prompter-flip";

function readPrompterOrientationFlag(key) {
  try { return localStorage.getItem(key) === "1"; } catch (e) { return false; }
}
function writePrompterOrientationFlag(key, on) {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch (e) {}
}

function applyPrompterOrientation() {
  var scroller = document.getElementById("prompter-scroll");
  scroller.classList.toggle("mirror", prompterMirror);
  scroller.classList.toggle("flip", prompterFlip);
  document.getElementById("pp-mirror").classList.toggle("is-active", prompterMirror);
  document.getElementById("pp-flip").classList.toggle("is-active", prompterFlip);
}

/* Deliberately not markDirty() — a rig preference, not a change to the
   document (issue #27). */
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

/* ---------- scene mode (issue #26) ----------

   Off by default, remembered per device (same localStorage convention as
   Mirror/Flip above — a reading preference, never written into the
   document). Cues one scene's first word to the reading line, auto-pauses
   once its last word passes that line, and Next/Previous re-cue the
   neighbour — skipping any scene "hide shot scenes" (issue #25) or the
   prompter's own "Skip shot" already left out of `source` entirely, since
   sceneRowIds (buildPrompterContent above) never lists them to begin with. */
var PROMPTER_SCENE_MODE_KEY = "splitpage-prompter-scene-mode";
var sceneRowIds = [];
var sceneWordStart = [];
var sceneWordEnd = [];
var promptSceneIndex = -1;
/* The CONTENT-space top (el.offsetTop — the scrollTop that would bring it
   to the very top of the scroller) of the current scene's last word, and
   the reading line's own distance from the top of the viewport. Both are
   plain numbers, cached once per cue/step rather than re-measured every
   animation frame, and comparing them needs nothing else from the DOM —
   see scenePastReadingLine(). */
var promptSceneEndWordOffset = null;
var promptSceneGuideOffset = 0;
/* The row the caret was last in, in either the split view or the writer —
   kept current by a focusin listener in 21-events.js. Read only by
   cueSceneForCurrentPosition() below, to cue "the scene Present was opened
   from" — capturing it here rather than at the moment Present is clicked,
   because a real click already moves focus to the button itself by then. */
S.lastFocusedRowId = null;

/* The one bit of geometry the auto-pause decision actually needs, pulled
   out on its own so it can be driven with plain numbers instead of a real
   scroll — the teleprompter's scroll speed can't be exercised headless
   (requestAnimationFrame is throttled in a background/headless window;
   see SKILL.md "What this cannot test"), but this function has no rAF and
   no live scroll in it at all, so a test can call it directly. `.prompter-
   guide` sits at top:50% of the viewport (app.css), so cueing a scene
   already leaves promptSceneGuideOffset at scroller.clientHeight/2 —
   scrolling to `scrollTop` has carried `wordTop` up to (or past) the
   guide once its distance from the top of the viewport has shrunk to
   `guideTop` or less. */
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
  var btn = document.getElementById("pp-scene-mode");
  if (btn) btn.classList.toggle("is-active", promptSceneMode);
  ["pp-scene-prev", "pp-scene-next", "pp-scene-readout"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.hidden = !promptSceneMode;
  });
  updateSceneReadout();
}

/* First index at or after (dir>0) / before (dir<0) `from`, inclusive, that
   actually has something to read — i.e. skipping the blank scenes
   buildPrompterContent() still counted but left zero-width. -1 means none
   in that direction. */
function findNonEmptySceneIndex(from, dir) {
  for (var i = from; i >= 0 && i < sceneRowIds.length; i += dir) {
    if (sceneWordEnd[i] > sceneWordStart[i]) return i;
  }
  return -1;
}

/* Scrolls scene `idx`'s first word to the reading line and arms its last
   word as the next auto-pause boundary. Does nothing (and reports it) for
   an out-of-range or empty scene — callers resolve to a real one first
   with findNonEmptySceneIndex. */
function cueScene(idx) {
  if (idx < 0 || idx >= sceneRowIds.length) return false;
  if (sceneWordEnd[idx] <= sceneWordStart[idx]) return false;
  var scroller = document.getElementById("prompter-scroll");
  var firstWord = S.promptWords[sceneWordStart[idx]].el;
  var lastWord = S.promptWords[sceneWordEnd[idx] - 1].el;
  promptSceneIndex = idx;
  promptSceneGuideOffset = scroller.clientHeight / 2;
  scroller.scrollTop = Math.max(0, firstWord.offsetTop - promptSceneGuideOffset);
  promptSceneEndWordOffset = lastWord.offsetTop;
  updateSceneReadout();
  return true;
}

/* Next/Previous (buttons and the keyboard shortcut) — always re-cues (a
   fresh scroll to the neighbour's first word), unlike the auto-pause path
   below, which deliberately leaves the reader sitting where they stopped. */
export function stepScene(dir) {
  if (!promptSceneMode || !sceneRowIds.length) return;
  var next = findNonEmptySceneIndex(promptSceneIndex + dir, dir);
  if (next === -1) return;
  setPrompterPlaying(false);
  cueScene(next);
}

/* Where scene mode picks up when the prompter opens (or scene mode itself
   switches on): the scene the caret was last in (lastFocusedRowId, kept
   current by a focusin listener in 21-events.js — it survives the click
   on Present itself, which always steals focus before this runs), or the
   first scene with something to read if that row has nothing spoken, is
   no longer here, or nothing was ever focused. */
export function cueSceneForCurrentPosition() {
  if (!sceneRowIds.length) { promptSceneIndex = -1; promptSceneEndWordOffset = null; updateSceneReadout(); return; }
  var idx = S.lastFocusedRowId ? sceneRowIds.indexOf(S.lastFocusedRowId) : -1;
  if (idx === -1) idx = 0;
  var resolved = findNonEmptySceneIndex(idx, 1);
  if (resolved === -1) resolved = findNonEmptySceneIndex(idx, -1);
  if (resolved === -1) { promptSceneIndex = -1; promptSceneEndWordOffset = null; updateSceneReadout(); return; }
  cueScene(resolved);
}

/* The one-shot auto-pause: fires once when the current scene's last word
   passes the reading line (from the scroll tick or, during Follow My
   Voice, from the recognised-word cursor), then arms the NEXT scene's end
   as the boundary and moves the readout on — without re-scrolling, so
   pressing Play again (or just talking on) continues straight into it
   rather than replaying it from its own first word. */
function advanceSceneAfterAutoPause() {
  var next = findNonEmptySceneIndex(promptSceneIndex + 1, 1);
  if (next === -1) { promptSceneEndWordOffset = null; return; }
  promptSceneIndex = next;
  promptSceneEndWordOffset = S.promptWords[sceneWordEnd[next] - 1].el.offsetTop;
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

export function openPrompter() {
  buildPrompterContent();
  var el = document.getElementById("prompter");
  el.hidden = false;
  S.prompterOpen = true;
  document.getElementById("prompter-scroll").scrollTop = 0;
  setPrompterPlaying(false);
  applyPrompterSize();
  applyPrompterOrientation();
  updatePrompterSceneModeUI();
  if (promptSceneMode) cueSceneForCurrentPosition();
  updateVoiceAvailability();
  acquireWakeLock();
}

export function closePrompter() {
  setPrompterPlaying(false);
  stopVoiceFollow();
  document.getElementById("prompter").hidden = true;
  S.prompterOpen = false;
  releaseWakeLock();
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(function () {});
  }
}

export function setPrompterPlaying(on) {
  if (on && S.voiceFollowActive) stopVoiceFollow();
  S.prompterPlaying = on;
  var btn = document.getElementById("pp-play");
  btn.textContent = on ? "❚❚ Pause" : "▶ Play";
  btn.classList.toggle("is-active", on);
  if (on) {
    S.prompterLastTs = null;
    S.prompterRAF = requestAnimationFrame(prompterTick);
  } else if (S.prompterRAF) {
    cancelAnimationFrame(S.prompterRAF);
    S.prompterRAF = null;
  }
}

function prompterTick(ts) {
  var scroller = document.getElementById("prompter-scroll");
  if (S.prompterLastTs == null) S.prompterLastTs = ts;
  var dt = (ts - S.prompterLastTs) / 1000;
  S.prompterLastTs = ts;
  scroller.scrollTop += S.prompterSpeed * dt;
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
  S.prompterRAF = requestAnimationFrame(prompterTick);
}

export function applyPrompterSize() {
  var size = document.getElementById("pp-size").value;
  document.getElementById("prompter-content").style.fontSize = size + "px";
}

/* ---------- voice follow ---------- */

function setVoiceStatus(msg, kind) {
  var el = document.getElementById("pp-voice-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "pp-voice-status" + (kind ? " " + kind : "");
}

/* What the voice button says when it is not following. On desktop it
   follows through Windows' own recogniser where main has one (issue #8,
   main.js section 9d); where it has none (not Windows, an older shell) it
   opens the script in the browser instead, and says so on the button
   rather than in small print. */
var VOICE_IDLE_LABEL = "Follow My Voice";
var VOICE_BROWSER_LABEL = "Open in browser to use Follow My Voice";
var VOICE_DESKTOP_UNAVAILABLE = "Follow My Voice isn't available in this desktop app — it works in the browser version.";

/* On desktop: does this machine listen for itself? */
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
  /* Whether main can listen is one question over the bridge, asked the
     first time the teleprompter needs to know; until the answer is in,
     the button waits rather than offering something it may not do. */
  if (S.DESKTOP && !desktopVoiceKnown()) {
    btn.disabled = true;
    loadDesktopVoice().then(updateVoiceAvailability);
    return;
  }
  if (!S.voiceFollowActive) btn.textContent = voiceIdleLabel();
  /* The Web Speech API's constructor exists in Electron's Chromium, but
     recognition itself fails immediately with a 'network' error — Google's
     speech backend that powers it is not reachable from inside Electron
     the way it is from an actual Chrome/Edge install. So desktop voice
     never uses it: on Windows main runs Windows' own recogniser and this
     page gets what it hears (createDesktopRecognition, 20f-desktop.js);
     anywhere main cannot, the button does the thing that works there — it
     opens this script in the default browser, starting in the
     teleprompter (issue #86, openPrompterInBrowser in 20f-desktop.js). A
     bridge too old for either keeps the honest disabled state. */
  if (S.DESKTOP) {
    if (desktopListens()) {
      btn.disabled = false;
      if (!S.voiceFollowActive && !S.voiceStarting) setVoiceStatus("", "");
    } else if (canOpenPrompterInBrowser()) {
      btn.disabled = false;
      setVoiceStatus("Chrome or Edge can follow your voice — this opens the saved script there.", "");
    } else {
      btn.disabled = true;
      setVoiceStatus(VOICE_DESKTOP_UNAVAILABLE, "");
    }
  } else if (!SpeechRecognitionCtor) {
    btn.disabled = true;
    setVoiceStatus("Voice follow needs Chrome or Edge.", "");
  } else if (!window.isSecureContext) {
    /* The API is right here — the browser just won't hand a microphone to
       a page opened straight off disk as file://. Saying "needs Chrome"
       here sends people to reinstall a browser they're already using;
       what actually fixes it is serving the page, which start.bat does. */
    btn.disabled = true;
    setVoiceStatus("Voice follow needs the app served over http:// — start it with start.bat.", "");
  } else {
    btn.disabled = false;
    if (!S.voiceFollowActive) setVoiceStatus("", "");
  }
}

function updateVoiceButtonUI() {
  var btn = document.getElementById("pp-voice");
  if (!btn) return;
  btn.classList.toggle("is-active", S.voiceFollowActive);
  btn.textContent = S.voiceFollowActive ? "Stop Following" : voiceIdleLabel();
}

function applySpokenUpTo(idx) {
  for (var i = 0; i < S.promptWords.length; i++) {
    var el = S.promptWords[i].el;
    el.classList.toggle("spoken", i < idx);
    el.classList.toggle("current-word", i === idx);
  }
}

function clearSpokenHighlights() {
  S.promptWords.forEach(function (w) {
    w.el.classList.remove("spoken");
    w.el.classList.remove("current-word");
  });
}

function scrollWordIntoView(idx) {
  var w = S.promptWords[idx];
  if (!w) return;
  w.el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* find where in the script the tail of what was just heard best lines up:
   for each candidate end position, count how many words match walking
   backward — rewards a run of consecutive matches near the speaker's
   actual position instead of one lucky common word */
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
  var combined = (S.finalTranscript + " " + S.interimTranscript).trim();
  var words = combined.split(/\s+/).map(normalizeWord).filter(Boolean);
  var recent = words.slice(-8);
  if (!recent.length || !S.speakNorms.length) return;

  /* Look a little way behind as well as ahead. Ahead covers a skipped or
     misheard phrase; behind is what lets a re-read ("sorry, again from
     the top of that line") re-sync instead of leaving the prompter
     stranded further down the page. */
  var searchStart = Math.max(0, S.speakCursor - 40);
  var searchEnd = Math.min(S.speakNorms.length - 1, S.speakCursor + 80);
  var best = findBestMatch(recent, S.speakNorms, searchStart, searchEnd);

  /* Going backwards needs a longer run of matching words than going
     forwards: one common word in a re-read shouldn't yank the reader back
     up the script, but two words is plenty to confirm normal progress. */
  if (best.index !== -1 && best.index !== S.speakCursor &&
      best.score >= (best.index > S.speakCursor ? 2 : 3)) {
    S.speakCursor = best.index;
    S.wordCursor = S.speakable[S.speakCursor];
    applySpokenUpTo(S.wordCursor);
    scrollWordIntoView(S.wordCursor);
    /* Scene mode's other stop: prompterTick's scroll-position check never
       runs during Follow My Voice (setPrompterPlaying(false) is what
       starts a voice session), so the boundary here is the recognised
       word position itself passing the end of the cued scene — reusing
       the same word-index space wordCursor already lives in, no scroll
       math needed. */
    if (promptSceneMode && promptSceneIndex !== -1 && S.wordCursor >= sceneWordEnd[promptSceneIndex]) {
      stopVoiceFollow();
      advanceSceneAfterAutoPause();
      setVoiceStatus("Scene finished — say it again to keep following, or press Next.", "listening");
    }
  }

  /* Only the last handful of words are ever matched against, so the rest
     is dead weight that would otherwise grow for the whole read. */
  if (S.finalTranscript.length > 4000) S.finalTranscript = S.finalTranscript.slice(-1200);

  if (S.speakCursor >= S.speakNorms.length - 1) {
    setVoiceStatus("Reached the end", "listening");
  } else if (S.voiceFollowActive) {
    setVoiceStatus("Listening — following along", "listening");
  }
}

function releaseVoiceStream() {
  if (!S.voiceStream) return;
  try { S.voiceStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  S.voiceStream = null;
}

/* What a desktop listener's warnings mean (desktop/voice/listen.ps1). They
   do not stop anything — the recogniser keeps listening — they say why it
   may not be following. */
var DESKTOP_VOICE_WARNINGS = {
  "no-signal": "Windows isn't hearing the microphone — check it's plugged in, and that Settings › Privacy & security › Microphone lets desktop apps use it.",
  "too-quiet": "Speak up a little, or move closer to the microphone.",
  "too-noisy": "It's noisy here — Follow My Voice may lose its place."
};

export async function startVoiceFollow() {
  /* Belt and braces: updateVoiceAvailability() already sets the button up
     for what this desktop can do, but this guard is what actually keeps a
     desktop start from ever reaching getUserMedia or the Web Speech
     recognizer, even if something else re-enables the button. */
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
  if (!desktop && !SpeechRecognitionCtor) return;
  /* recognition.start() is async and voiceFollowActive only flips in onstart,
     so without this a second click builds a second recognizer and orphans the
     first — an invisible live microphone session. */
  if (S.voiceFollowActive || S.voiceStarting) return;
  if (!S.speakNorms.length) {
    setVoiceStatus("Nothing to read yet.", "error");
    return;
  }
  S.voiceStarting = true;
  var mySession = ++S.voiceSession;
  setPrompterPlaying(false);
  S.finalTranscript = "";
  S.interimTranscript = "";
  S.wordCursor = -1;
  S.speakCursor = -1;
  S.voiceRestarts = 0;
  clearSpokenHighlights();

  /* Take the microphone once, up front, on the click that asked for it —
     and keep it (see voiceStream). Without this the browser re-prompts
     every time Chrome's own ~60-second session limit expires and we
     restart, which makes a long read unusable. Doing it here also lets us
     tell a refusal apart from a missing device, which the recognizer's own
     error reporting blurs together. */
  /* Not on desktop: Windows' listener opens the microphone itself, in its
     own process, and a second capture here would only light a second
     recording indicator. */
  if (!desktop && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    setVoiceStatus("Asking for the microphone…", "");
    try {
      S.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      S.voiceStarting = false;
      var name = err && err.name;
      setVoiceStatus(
        name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No microphone was found."
          : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.",
        "error");
      return;
    }
    /* stopped while the permission prompt was still up */
    if (mySession !== S.voiceSession) { releaseVoiceStream(); S.voiceStarting = false; return; }
  }

  try {
    S.recognition = desktop ? createDesktopRecognition() : new SpeechRecognitionCtor();
  } catch (e) {
    S.voiceStarting = false;
    releaseVoiceStream();
    setVoiceStatus("Could not start speech recognition.", "error");
    return;
  }
  S.recognition.continuous = true;
  S.recognition.interimResults = true;
  S.recognition.lang = "en-US";

  if (desktop) {
    setVoiceStatus("Starting Windows speech recognition…", "");
    S.recognition.onwarning = function (e) {
      var msg = DESKTOP_VOICE_WARNINGS[e && e.warning];
      if (msg && S.voiceFollowActive) setVoiceStatus(msg, "error");
    };
  }
  S.recognition.onstart = function () {
    S.voiceStarting = false;
    S.voiceFollowActive = true;
    updateVoiceButtonUI();
    setVoiceStatus("Listening…", "listening");
  };
  S.recognition.onresult = function (e) {
    var finalChunk = "", interimChunk = "";
    for (var i = e.resultIndex; i < e.results.length; i++) {
      var r = e.results[i];
      if (r.isFinal) finalChunk += r[0].transcript + " ";
      else interimChunk += r[0].transcript + " ";
    }
    if (finalChunk) S.finalTranscript += finalChunk;
    S.interimTranscript = interimChunk;
    S.voiceRestarts = 0; /* hearing something is the only real proof it's healthy */
    onSpeechTranscript();
  };
  S.recognition.onerror = function (e) {
    S.voiceStarting = false;
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setVoiceStatus(desktop
        ? "Microphone blocked — let desktop apps use it in Settings › Privacy & security › Microphone, then try again."
        : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.", "error");
      S.voiceFollowActive = false;
    } else if (e.error === "no-recognizer") {
      /* Windows' listener: no speech recogniser is installed at all. */
      setVoiceStatus("Windows has no speech recogniser installed. Add one in Settings › Time & language › Speech, or use Present in Browser.", "error");
      S.voiceFollowActive = false;
    } else if (e.error === "taken") {
      setVoiceStatus("Another tab is following your voice now.", "");
      S.voiceFollowActive = false;
    } else if (e.error === "helper-failed" || e.error === "unavailable") {
      /* Windows' listener could not run at all. Starting it again would
         only fail the same way, forty times. */
      setVoiceStatus("Windows speech recognition couldn't start. Present in Browser still works.", "error");
      S.voiceFollowActive = false;
    } else if (e.error === "audio-capture") {
      setVoiceStatus("No microphone was found.", "error");
      S.voiceFollowActive = false;
    } else if (e.error === "network") {
      setVoiceStatus("Speech recognition needs an internet connection.", "error");
    } else {
      setVoiceStatus("Voice follow hit an error (" + e.error + ").", "error");
    }
    updateVoiceButtonUI();
  };
  /* Chrome ends a continuous session on its own every so often — after a
     silence, and after any transient error — so following someone through
     a long read means restarting it. Backing off stops that turning into a
     tight restart loop (and a stuttering mic indicator) when whatever
     ended it isn't going to clear on its own. */
  S.recognition.onend = function () {
    /* Not following any more — either stopped, or onerror gave up. This is
       the one place every such path passes through, so it is where the
       microphone gets handed back. */
    if (mySession !== S.voiceSession || !S.voiceFollowActive) {
      if (mySession === S.voiceSession) releaseVoiceStream();
      updateVoiceButtonUI();
      return;
    }
    S.voiceRestarts++;
    if (S.voiceRestarts > 40) {
      S.voiceFollowActive = false;
      releaseVoiceStream();
      updateVoiceButtonUI();
      setVoiceStatus("Voice follow kept dropping out — stopped.", "error");
      return;
    }
    setTimeout(function () {
      if (mySession !== S.voiceSession || !S.voiceFollowActive || !S.recognition) return;
      try { S.recognition.start(); }
      catch (e) {
        /* start() throwing synchronously (Chrome's "recognition has
           already started" when it hasn't fully torn down the previous
           session yet) means no further "end" event will ever fire for
           this attempt — this is a dead end, not just a stopped follow.
           Release the mic now, or it stays open (and the leaked
           `recognition` reference blocks a later manual restart from
           ever cleaning it up) with the UI showing "stopped". */
        S.voiceFollowActive = false;
        S.recognition = null;
        releaseVoiceStream();
        updateVoiceButtonUI();
      }
    }, Math.min(2000, 150 * S.voiceRestarts));
  };
  try {
    S.recognition.start();
  } catch (e) {
    S.voiceStarting = false;
    releaseVoiceStream();
    setVoiceStatus("Could not start speech recognition.", "error");
  }
}

export function stopVoiceFollow() {
  var wasActive = S.voiceFollowActive;
  S.voiceSession++; /* strands any restart already queued by the old session */
  S.voiceFollowActive = false;
  S.voiceStarting = false;
  if (S.recognition) {
    /* drop onresult too — Chrome flushes in-flight results after stop() and
       a stale one would move the prompter after a restart */
    try { S.recognition.onend = null; S.recognition.onresult = null; S.recognition.stop(); } catch (e) {}
    S.recognition = null;
  }
  /* hand the microphone back the moment following stops, so the browser's
     recording indicator reflects what is actually happening */
  releaseVoiceStream();
  updateVoiceButtonUI();
  if (wasActive) setVoiceStatus("", "");
}

/* ---------- arriving from the desktop app (issue #86) ----------

   The other half of the desktop teleprompter's "Open in browser". The
   desktop shell (desktop/main.js section 9b) opens one of two addresses in
   the default browser, and this is where the browser build recognises them:

     ?teleprompter=1#script=<64 hex>
         served by the desktop app's own loopback listener
         (desktop/prompter-share.js): the page fetches the script from
         prompter-script/<token> on the same origin, opens it as a project,
         and starts in the teleprompter. A COPY to read from — no file
         handle, so nothing here can write back over the desktop's file,
         and no "before opening" snapshot, so no copy of the script is
         left in this origin's version history.
     ?doc=<id>&teleprompter=1
         served by the desktop app's document server: 13-hosted.js opens
         the hosted document from ?doc= as it does for any shared link
         (after the join PIN, if the server has one), and the teleprompter
         opens once it has.

   Both parameters leave the address bar as soon as they are read — the
   token especially, like the review key in 13-hosted.js: it is in the
   fragment so no server ever sees it, and out of the bar so it is not in a
   screenshot or a bookmark. It is kept in sessionStorage (this tab only)
   so a reload re-reads the script for as long as the desktop still shares
   it. */
var PROMPTER_LAUNCH_KEY = "splitpage-prompter-launch";
var PROMPTER_TOKEN_RE = /^[0-9a-f]{64}$/;
/* Long enough for someone to type a join PIN; short enough that a page
   which never reaches its document does not spring the prompter open on
   something else much later. */
var HOSTED_LAUNCH_WAIT_MS = 5 * 60 * 1000;

function readPrompterLaunch() {
  if (S.DESKTOP) return null;
  var wanted;
  try { wanted = new URLSearchParams(location.search).get("teleprompter") === "1"; } catch (e) { wanted = false; }
  var m = /(?:^#|&)script=([0-9a-f]{64})(?=&|$)/.exec(location.hash || "");
  var token = m ? m[1] : "";
  if (wanted || token) {
    try {
      var url = new URL(location.href);
      url.searchParams.delete("teleprompter");
      var rest = (url.hash || "").replace(/(^#|&)script=[0-9a-f]{64}/, "$1").replace(/^#&/, "#");
      if (rest === "#") rest = "";
      history.replaceState(null, "", url.pathname + url.search + rest);
    } catch (e) { /* the launch is already in hand; the bar keeping it is cosmetic */ }
  }
  if (token) {
    try { sessionStorage.setItem(PROMPTER_LAUNCH_KEY, token); } catch (e) { /* no reload, that's all */ }
    return { token: token };
  }
  if (wanted) return { hosted: true };
  var kept;
  try { kept = sessionStorage.getItem(PROMPTER_LAUNCH_KEY) || ""; } catch (e) { kept = ""; }
  return PROMPTER_TOKEN_RE.test(kept) ? { token: kept } : null;
}

/* init() (21-events.js) may wait for DOMContentLoaded before it creates
   S.initialStateReady, so this cannot simply read it from __init(). */
function whenInitialStateReady() {
  return new Promise(function (resolve) {
    (function check() {
      if (S.initialStateReady) S.initialStateReady.then(resolve, resolve);
      else setTimeout(check, 50);
    })();
  });
}

function showPrompterForLaunch() {
  /* A tab that arrives to read a script is not someone arriving at the app:
     the New Tab page has no business over it (20j-newtab.js shows itself
     over the pristine demo this tab booted with). */
  closeNewTabPage();
  if (!S.prompterOpen) openPrompter();
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
    showToast("Couldn't read the script the desktop app sent.", "error", true);
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
  /* The first-run wizard asks someone new to the app what they came for.
     This tab came for a script, from an app they already use — and the
     wizard's own gate (20b-onboarding.js) can decide before the script has
     arrived. Marked done for this origin, the same record Skip writes. */
  try {
    if (!localStorage.getItem(ONBOARD_KEY)) {
      localStorage.setItem(ONBOARD_KEY, JSON.stringify({ v: 1, done: true, skipped: true, at: "prompter-launch" }));
    }
  } catch (e) { /* private browsing — the wizard just shows */ }
  whenInitialStateReady().then(function () {
    if (launch.token) return launchPrompterFromScript(launch.token);
    launchPrompterForServerDoc();
  });
}

/* Shared by every panel that renders tagEntityHtml() cards. The card's own
   buttons (status pill, expand, rename, remove/delete) are all data-action
   and already work from any container through onRootClick — this wires
   the handful of non-click events the card also needs: Enter/Escape in
   the rename and add-person inputs, the owner <select>, and the notes
   textarea. Bulk selection and its bar are production-panel-only extras,
   layered on separately where each panel is wired in init(). */
export function wireTagEntityContainer(id) {
  var el = document.getElementById(id);
  el.addEventListener("click", onRootClick);
  el.addEventListener("keydown", function (e) {
    if (!e.target.classList) return;
    if (e.target.classList.contains("tag-rename-input")) {
      if (e.key === "Enter") { e.preventDefault(); saveTagRename(e.target.getAttribute("data-key")); }
      else if (e.key === "Escape") { e.preventDefault(); S.tagRenaming = null; renderProduction(); }
      return;
    }
    if (e.target.classList.contains("tag-person-input")) {
      if (e.key === "Enter") { e.preventDefault(); addPersonForTag(e.target.getAttribute("data-key")); }
      else if (e.key === "Escape") { e.preventDefault(); S.tagAddingPersonFor = null; renderProduction(); }
    }
  });
  el.addEventListener("change", function (e) {
    if (e.target.classList && e.target.classList.contains("tag-owner-select")) {
      setTagOwner(e.target.getAttribute("data-key"), e.target.value);
    }
  });
  el.addEventListener("input", function (e) {
    if (e.target.classList && e.target.classList.contains("tag-notes-input")) {
      setTagNotes(e.target.getAttribute("data-key"), e.target.value);
    }
  });
  /* notes save continuously as you type (see setTagNotes); the autosave is
     held until you leave the box so it isn't queued on every keystroke */
  el.addEventListener("focusout", function (e) {
    if (e.target.classList && e.target.classList.contains("tag-notes-input")) queueAutoSave();
  });
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  prompterMirror = readPrompterOrientationFlag(PROMPTER_MIRROR_KEY);

  prompterFlip = readPrompterOrientationFlag(PROMPTER_FLIP_KEY);

  promptSceneMode = readPrompterOrientationFlag(PROMPTER_SCENE_MODE_KEY);

  /* ---- test hook ----
     Everything in src/js shares one closure (00-prelude.js), so a driver
     script has no way to reach scenePastReadingLine or trigger the
     boundary check it drives — and no way to reproduce it through a real
     scroll either, since requestAnimationFrame is throttled in a
     background/headless window (SKILL.md "What this cannot test"). This is
     the sanctioned way around both: a way to run the exact check
     prompterTick makes every frame against whatever scrollTop a test sets
     on #prompter-scroll — no animation needed. Nothing in the app itself reads this; the same trick
     window.__updateTest (20a-update.js) and window.__historyTest
     (03a-history-store.js) play. */
  window.__prompterTest = {
    checkSceneBoundaryNow: function () {
      var scroller = document.getElementById("prompter-scroll");
      if (!promptSceneMode || promptSceneEndWordOffset == null) return false;
      if (!scenePastReadingLine(scroller.scrollTop, promptSceneEndWordOffset, promptSceneGuideOffset)) return false;
      setPrompterPlaying(false);
      advanceSceneAfterAutoPause();
      return true;
    },
    /* Follow My Voice needs a real microphone (no headless input — see
       startVoiceFollow), so this drives just the scene-boundary half of
       onSpeechTranscript()'s own check, with a caller-given word index
       standing in for wherever real recognised speech would have landed. */
    simulateVoiceWordCursor: function (idx) {
      S.wordCursor = idx;
      if (!promptSceneMode || promptSceneIndex === -1 || S.wordCursor < sceneWordEnd[promptSceneIndex]) return false;
      stopVoiceFollow();
      advanceSceneAfterAutoPause();
      return true;
    },
    /* The desktop's Open in browser, from the browser's end (issue #86):
       the same function a ?teleprompter=1#script=<token> load runs, so a
       suite can drive it with a stubbed fetch — no suite's static server
       can answer prompter-script/<token> the way the desktop's listener
       does. */
    launchFromScript: launchPrompterFromScript
  };

  var launch = readPrompterLaunch();
  if (launch) startPrompterLaunch(launch);
}
