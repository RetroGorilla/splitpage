import { pad2, formatTimecode, rowSeconds } from "../../core/production/timing.ts";
import { withoutCues } from "../../core/text/cues.ts";
import { sliceCell } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { toPlainText } from "../../core/text/projections.ts";
import { projection } from "../../core/text/runs.ts";
import type { CellInput, Run } from "../../core/text/runs.ts";
import type { PrompterRecognition } from "../../application/prompter-services.ts";
import type { PrompterFeaturePorts, PrompterRuntime } from "./ports.ts";

type PrompterSpeechResult = { readonly isFinal: boolean; readonly 0: { readonly transcript: string } };
type VoiceRecognition = PrompterRecognition & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: { readonly resultIndex: number; readonly results: { readonly length: number; readonly [index: number]: PrompterSpeechResult } }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  onwarning: ((event: { readonly warning?: string } | null) => void) | null;
  ondevice: ((event: { readonly name?: unknown } | null) => void) | null;
};

type TimerHandle = ReturnType<typeof setTimeout>;
type PrompterDoc = {
  readonly rows: readonly (Parameters<typeof rowSeconds>[0] & { readonly id: string; readonly status?: string | undefined })[];
  readonly wordsPerMinute?: number | null | undefined;
};
type PromptWord = { el: HTMLElement; norm: string };
type SceneView = { html: string; words: number };
type SceneEntry = { id: string; cell: Run[]; view: SceneView | null };
type SceneLine = SceneEntry & { view: SceneView };
type PrompterLaunch = { token?: string; hosted?: boolean };
type PrompterTestHooks = {
  checkSceneBoundaryNow: () => boolean;
  simulateVoiceWordCursor: (idx: number) => boolean;
  launchFromScript: (token: string) => Promise<boolean>;
  updateStatus: () => void;
};
type PrompterWindow = Window & { __prompterTest?: PrompterTestHooks };

let ports: PrompterFeaturePorts;
let initialReadyTimer: TimerHandle | null = null;

export let prompterMirror: boolean;
export let prompterFlip: boolean;
let promptSceneMode: boolean;

let prompterSpeed = 42;
let prompterRAF: number | null = null;
let prompterLastTs: number | null = null;
let recognition: VoiceRecognition | null = null;
let voiceStarting = false;
let promptWords: PromptWord[] = [];
let wordCursor = -1;
let speakable: number[] = [];
let speakNorms: string[] = [];
let speakCursor = -1;
let voiceRestarts = 0;
let voiceSession = 0;
let voiceStream: MediaStream | null = null;
let finalTranscript = "";
let interimTranscript = "";

function normalizeWord(w: unknown): string {
  return String(w || "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

export function prompterSceneHtml(cell: CellInput): SceneView {
  let words = 0;
  const html = toHtml(cell, {
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

export function trimPrompterCell(cell: CellInput): Run[] {
  const p = projection(cell);
  const lead = p.length - p.replace(/^[^\S\u00a0]+/, "").length;
  const tail = p.length - p.replace(/[^\S\u00a0]+$/, "").length;
  return lead + tail >= p.length ? [] : sliceCell(cell, lead, p.length - tail);
}

const SENTENCE_END_RE = /[.!?]["'’”)\]]*$/;

export function buildPrompterContent(): void {
  const skippingShot = ports.state.skipsShot() || ports.viewFlags.hideShot();
  const doc = ports.document.current() as PrompterDoc;
  const source = skippingShot
    ? doc.rows.filter(function (row) { return row.status !== "shot"; })
    : doc.rows;
  const sceneEntries = source.map(function (row): SceneEntry {
    const cell = trimPrompterCell(withoutCues(ports.text.cellOf(row.audioText)));
    return { id: row.id, cell: cell, view: cell.length ? prompterSceneHtml(cell) : null };
  });
  const lines = sceneEntries.filter(function (e) { return e.view; }) as SceneLine[];

  const paragraphs: string[] = [];
  lines.forEach(function (e, i) {
    const prevEndsSentence = i === 0 || SENTENCE_END_RE.test(toPlainText((lines[i - 1] as SceneLine).cell));
    if (prevEndsSentence) paragraphs.push(e.view.html);
    else paragraphs[paragraphs.length - 1] += " " + e.view.html;
  });

  const content = document.getElementById("prompter-content") as HTMLElement;
  if (!paragraphs.length) {
    content.innerHTML = '<div class="prompter-empty">' + (skippingShot
      ? "Every scene is marked Shot — switch off Skip shot (or Hide shot scenes) to read them again."
      : "Nothing to read yet — add some audio text first.") + '</div>';
    promptWords = [];
  } else {
    content.innerHTML = paragraphs.map(function (html) {
      return '<div class="prompter-line">' + html + '</div>';
    }).join("");
    promptWords = Array.prototype.map.call(content.querySelectorAll(".w"), function (el: HTMLElement): PromptWord {
      return { el: el, norm: normalizeWord(el.textContent) };
    }) as PromptWord[];
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
  let cursor = 0;
  sceneEntries.forEach(function (e) {
    const n = e.view ? e.view.words : 0;
    sceneRowIds.push(e.id);
    sceneWordStart.push(cursor);
    cursor += n;
    sceneWordEnd.push(cursor);
  });
  promptSceneIndex = -1;
  promptSceneEndWordOffset = null;

  sceneSeconds = [];
  sceneStartSec = [];
  let t = 0;
  source.forEach(function (row) {
    const secs = rowSeconds(row, doc, ports.text.productionReaders);
    sceneStartSec.push(t);
    sceneSeconds.push(secs);
    t += secs;
  });
  promptTotalSec = t;
  renderPrompterRundown();
  const skip = document.getElementById("pp-skip-shot");
  if (skip) skip.setAttribute("aria-pressed", ports.state.skipsShot() ? "true" : "false");
}

let sceneSeconds: number[] = [];
let sceneStartSec: number[] = [];
let promptTotalSec = 0;
let rundownBlockEls: (HTMLElement | null)[] = [];
let rundownBlockIndex: number[] = [];
let paintedScene = -2;
let promptLinePx = 60 * 1.42;

function renderPrompterRundown(): void {
  const track = document.getElementById("pp-rd-track");
  if (!track) return;
  let html = "";
  let count = 0;
  rundownBlockIndex = sceneSeconds.map(function (secs) {
    const before = count;
    if (secs > 0) {
      html += '<span class="pp-rd-block" style="flex-grow:' + Math.round(secs * 1000) / 1000 + '"></span>';
      count++;
    }
    return before;
  });
  track.innerHTML = count ? html + '<span class="pp-rd-head" aria-hidden="true"></span>' : "";
  track.style.setProperty("--pp-blocks", String(count));
  const els = track.querySelectorAll<HTMLElement>(".pp-rd-block");
  rundownBlockEls = sceneSeconds.map(function (secs, i) {
    return secs > 0 ? els[rundownBlockIndex[i] as number] as HTMLElement : null;
  });
  paintedScene = -2;
}

function readingPosition(scroller: HTMLElement): number {
  const words = promptWords;
  const n = words.length;
  if (!n) return 0;
  const guide = scroller.scrollTop + scroller.clientHeight / 2;
  let lo = 0, hi = n - 1, last = -1, mid: number;
  while (lo <= hi) {
    mid = (lo + hi) >> 1;
    if ((words[mid] as PromptWord).el.offsetTop <= guide + 0.5) { last = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (last === -1) return 0;
  const top = (words[last] as PromptWord).el.offsetTop;
  lo = 0; hi = last;
  while (lo < hi) {
    mid = (lo + hi) >> 1;
    if ((words[mid] as PromptWord).el.offsetTop >= top - promptLinePx / 2) hi = mid; else lo = mid + 1;
  }
  const next = last + 1;
  const nextTop = next < n ? (words[next] as PromptWord).el.offsetTop : top + promptLinePx;
  const frac = nextTop > top ? Math.min(1, Math.max(0, (guide - top) / (nextTop - top))) : 0;
  return lo + frac * (next - lo);
}

function sceneAtWord(pos: number): number {
  const w = Math.min(Math.floor(pos), promptWords.length - 1);
  let lo = 0, hi = sceneWordEnd.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sceneWordEnd[mid] as number) > w) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

export function updatePrompterStatus(): void {
  if (!ports.state.isOpen()) return;
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  let scene = -1, elapsed = 0;
  if (promptWords.length && sceneRowIds.length) {
    const pos = readingPosition(scroller);
    scene = sceneAtWord(pos);
    const span = (sceneWordEnd[scene] as number) - (sceneWordStart[scene] as number);
    const into = span > 0 ? Math.min(1, Math.max(0, (pos - (sceneWordStart[scene] as number)) / span)) : 0;
    elapsed = (sceneStartSec[scene] as number) + (sceneSeconds[scene] as number) * into;
  }

  const posEl = document.getElementById("pp-scene-pos");
  setText(posEl, scene === -1 ? "" : pad2(scene + 1) + " / " + pad2(sceneRowIds.length));
  setText(document.getElementById("pp-scene-pos-sr"), scene === -1 ? "" : "Scene " + (scene + 1) + " of " + sceneRowIds.length);
  setText(document.getElementById("pp-scene-start"), scene === -1 ? "" : formatTimecode(sceneStartSec[scene] as number));
  const read = Math.round(elapsed);
  const total = Math.round(promptTotalSec);
  const readText = formatTimecode(read);
  const leftText = formatTimecode(Math.max(0, total - read));
  setText(document.getElementById("pp-elapsed"), readText);
  setText(document.getElementById("pp-remaining"), "−" + leftText);
  const clock = document.getElementById("pp-clock");
  if (clock) clock.setAttribute("aria-label", "Elapsed " + readText + ", " + leftText + " left");
  const bar = document.getElementById("pp-rundown");
  if (bar) {
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(Math.min(read, total)));
    bar.setAttribute("aria-valuetext", readText + " of " + formatTimecode(total));
  }

  const track = document.getElementById("pp-rd-track");
  if (!track || !promptTotalSec) return;
  if (scene !== paintedScene) {
    rundownBlockEls.forEach(function (el, i) {
      if (!el) return;
      el.classList.toggle("is-played", i < scene);
      el.classList.toggle("is-current", i === scene);
    });
    paintedScene = scene;
  }
  const cur = scene === -1 ? null : rundownBlockEls[scene];
  if (cur) cur.style.setProperty("--p", ((sceneSeconds[scene] as number) ? (elapsed - (sceneStartSec[scene] as number)) / (sceneSeconds[scene] as number) * 100 : 0) + "%");
  track.style.setProperty("--pp-at", String(Math.min(1, elapsed / promptTotalSec)));
  track.style.setProperty("--pp-i", String(scene === -1 ? 0 : rundownBlockIndex[scene]));
}

let prompterWakeLock: WakeLockSentinel | null = null;
let wakeLockGen = 0;

export function acquireWakeLock(owns?: () => boolean): void {
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  const gen = ++wakeLockGen;
  navigator.wakeLock.request("screen").then(function (lock) {
    if (gen !== wakeLockGen || !ports.state.isOpen() || (owns && !owns())) { lock.release().catch(function () {}); return; }
    prompterWakeLock = lock;
  }).catch(function () { });
}

function releaseWakeLock(): void {
  wakeLockGen++;
  if (prompterWakeLock) {
    prompterWakeLock.release().catch(function () {});
    prompterWakeLock = null;
  }
}

export function disposePrompterView(): void {
  setPrompterPlaying(false);
  stopVoiceFollow();
  releaseWakeLock();
}

function applyPrompterOrientation(): void {
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  scroller.classList.toggle("mirror", prompterMirror);
  scroller.classList.toggle("flip", prompterFlip);
  const prompter = document.getElementById("prompter") as HTMLElement;
  prompter.classList.toggle("pp-mirrored", prompterMirror);
  prompter.classList.toggle("pp-flipped", prompterFlip);
  setToggle(document.getElementById("pp-mirror"), prompterMirror);
  setToggle(document.getElementById("pp-flip"), prompterFlip);
}

function setToggle(btn: HTMLElement | null, on: boolean): void {
  if (!btn) return;
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

export function setPrompterMirror(on: boolean): void {
  prompterMirror = on;
  ports.preferences.setPrompterFlag("prompterMirror", on);
  applyPrompterOrientation();
}
export function setPrompterFlip(on: boolean): void {
  prompterFlip = on;
  ports.preferences.setPrompterFlag("prompterFlip", on);
  applyPrompterOrientation();
}

let sceneRowIds: string[] = [];
let sceneWordStart: number[] = [];
let sceneWordEnd: number[] = [];
let promptSceneIndex = -1;
let promptSceneEndWordOffset: number | null = null;
let promptSceneGuideOffset = 0;

function scenePastReadingLine(scrollTop: number, wordTop: number, guideTop: number): boolean {
  return (wordTop - scrollTop) <= guideTop;
}

export function updateSceneReadout(): void {
  const el = document.getElementById("pp-scene-readout");
  if (!el) return;
  if (!promptSceneMode || promptSceneIndex === -1 || !sceneRowIds.length) { el.textContent = ""; return; }
  el.textContent = "Scene " + (promptSceneIndex + 1) + " of " + sceneRowIds.length;
}

function updatePrompterSceneModeUI(): void {
  setToggle(document.getElementById("pp-scene-mode"), promptSceneMode);
  ["pp-scene-step", "pp-scene-prev", "pp-scene-next", "pp-scene-readout"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.hidden = !promptSceneMode;
  });
  updateSceneReadout();
}

function findNonEmptySceneIndex(from: number, dir: number): number {
  for (let i = from; i >= 0 && i < sceneRowIds.length; i += dir) {
    if ((sceneWordEnd[i] as number) > (sceneWordStart[i] as number)) return i;
  }
  return -1;
}

function cueScene(idx: number): boolean {
  if (idx < 0 || idx >= sceneRowIds.length) return false;
  if ((sceneWordEnd[idx] as number) <= (sceneWordStart[idx] as number)) return false;
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  const firstWord = (promptWords[sceneWordStart[idx] as number] as PromptWord).el;
  const lastWord = (promptWords[(sceneWordEnd[idx] as number) - 1] as PromptWord).el;
  promptSceneIndex = idx;
  promptSceneGuideOffset = scroller.clientHeight / 2;
  scroller.scrollTop = Math.max(0, firstWord.offsetTop - promptSceneGuideOffset);
  promptSceneEndWordOffset = lastWord.offsetTop;
  updateSceneReadout();
  updatePrompterStatus();
  return true;
}

export function stepScene(dir: number): void {
  if (!promptSceneMode || !sceneRowIds.length) return;
  const next = findNonEmptySceneIndex(promptSceneIndex + dir, dir);
  if (next === -1) return;
  setPrompterPlaying(false);
  cueScene(next);
}

export function cueSceneForCurrentPosition(): void {
  if (!sceneRowIds.length) { promptSceneIndex = -1; promptSceneEndWordOffset = null; updateSceneReadout(); return; }
  const lastRow = ports.focus.lastRow();
  let idx = lastRow ? sceneRowIds.indexOf(lastRow) : -1;
  if (idx === -1) idx = 0;
  let resolved = findNonEmptySceneIndex(idx, 1);
  if (resolved === -1) resolved = findNonEmptySceneIndex(idx, -1);
  if (resolved === -1) { promptSceneIndex = -1; promptSceneEndWordOffset = null; updateSceneReadout(); return; }
  cueScene(resolved);
}

function advanceSceneAfterAutoPause(): void {
  const next = findNonEmptySceneIndex(promptSceneIndex + 1, 1);
  if (next === -1) { promptSceneEndWordOffset = null; return; }
  promptSceneIndex = next;
  promptSceneEndWordOffset = (promptWords[(sceneWordEnd[next] as number) - 1] as PromptWord).el.offsetTop;
  updateSceneReadout();
}

export function setPrompterSceneMode(on: boolean): void {
  on = !!on;
  if (on === promptSceneMode) return;
  promptSceneMode = on;
  ports.preferences.setPrompterFlag("prompterSceneMode", on);
  updatePrompterSceneModeUI();
  if (on) cueSceneForCurrentPosition();
  else { promptSceneIndex = -1; promptSceneEndWordOffset = null; }
}

let prompterLeaveSeq = 0;

function lockPageScrollWhenArrived(el: HTMLElement): void {
  const owner = ports;
  const lock = function () { if (ports === owner && ports.state.isOpen()) document.body.classList.add("prompter-open"); };
  const arriving = el.getAnimations ? el.getAnimations().filter(function (a) {
    return a.effect && (a.effect as KeyframeEffect).target === el;
  }) : [];
  if (!arriving.length) { lock(); return; }
  Promise.all(arriving.map(function (a) { return a.finished; })).then(lock, function () {});
}

export function openPrompter(): void {
  ports.panels.closeAll();
  buildPrompterContent();
  const el = document.getElementById("prompter") as HTMLElement;
  prompterLeaveSeq++;
  el.classList.remove("is-holding");
  el.inert = false;
  el.hidden = false;
  ports.state.setOpen(true);
  lockPageScrollWhenArrived(el);
  (document.getElementById("prompter-scroll") as HTMLElement).scrollTop = 0;
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

export function closePrompter(): void {
  setPrompterPlaying(false);
  stopVoiceFollow();
  ports.state.setOpen(false);
  releaseWakeLock();
  const el = document.getElementById("prompter") as HTMLElement;
  if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  el.inert = true;
  const seq = ++prompterLeaveSeq;
  if (document.fullscreenElement) {
    el.classList.add("is-holding");
    const fade = function () { if (seq === prompterLeaveSeq) el.classList.remove("is-holding"); };
    document.exitFullscreen().then(fade, fade);
    setTimeout(fade, 1000);
  }
  el.hidden = true;
  document.body.classList.remove("prompter-open");
}

export function setPrompterPlaying(on: boolean): void {
  if (on && ports.state.voiceFollowing()) stopVoiceFollow();
  ports.state.setPlaying(on);
  const btn = document.getElementById("pp-play") as HTMLElement;
  const icon = btn.querySelector("use");
  const label = btn.querySelector(".pp-sr");
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

function prompterTick(ts: number): void {
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  if (prompterLastTs == null) prompterLastTs = ts;
  const dt = (ts - prompterLastTs) / 1000;
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

export function applyPrompterSize(): void {
  const size = Number((document.getElementById("pp-size") as HTMLInputElement).value);
  (document.getElementById("prompter") as HTMLElement).style.setProperty("--pp-size", size + "px");
  promptLinePx = size * 1.42;
  setText(document.getElementById("pp-size-value"), String(size));
  updatePrompterStatus();
}

const PROMPTER_SIZE_DEFAULT = 60;
const PROMPTER_SIZE_PHONE = 36;
let promptSizeDefaultSet: number | null = null;

function applyPrompterDefaultSize(): void {
  const input = document.getElementById("pp-size") as HTMLInputElement;
  if (promptSizeDefaultSet !== null && Number(input.value) !== promptSizeDefaultSet) return;
  const phone = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
  promptSizeDefaultSet = phone ? PROMPTER_SIZE_PHONE : PROMPTER_SIZE_DEFAULT;
  input.value = String(promptSizeDefaultSet);
}

const PROMPTER_SIZE_STEP = 4;

export function stepPrompterSize(dir: number): void {
  const input = document.getElementById("pp-size") as HTMLInputElement;
  const next = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + dir * PROMPTER_SIZE_STEP));
  input.value = String(next);
  applyPrompterSize();
}

const PROMPTER_SPEED_STEP = 6;
const PROMPTER_SPEED_BASE = 42;

export function setPrompterSpeed(value: number): void {
  const input = document.getElementById("pp-speed") as HTMLInputElement;
  prompterSpeed = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(value)));
  input.value = String(prompterSpeed);
  syncSpeedReadout();
}

export function stepPrompterSpeed(dir: number): void {
  setPrompterSpeed(prompterSpeed + dir * PROMPTER_SPEED_STEP);
}

function syncSpeedReadout(): void {
  setText(document.getElementById("pp-speed-value"), (prompterSpeed / PROMPTER_SPEED_BASE).toFixed(1) + "×");
}

function setVoiceStatus(msg: string, kind: string): void {
  const el = document.getElementById("pp-voice-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "pp-voice-status" + (kind ? " " + kind : "");
  syncVoiceState();
}

function syncVoiceState(): void {
  const group = document.getElementById("pp-voice-state");
  const el = document.getElementById("pp-voice-status");
  if (!group || !el) return;
  group.classList.toggle("is-live", !!ports.state.voiceFollowing());
  group.classList.toggle("has-msg", !!el.textContent);
}

function setVoiceLabel(btn: HTMLElement, text: string): void {
  const label = btn.querySelector(".pp-voice-label");
  if (label) label.textContent = text;
  else btn.textContent = text;
}

let voiceMicName = "";
function listeningStatus(fallback: string): string {
  return voiceMicName ? "Listening — " + voiceMicName : fallback;
}

const VOICE_IDLE_LABEL = "Follow My Voice";
const VOICE_BROWSER_LABEL = "Open in browser to use Follow My Voice";
const VOICE_DESKTOP_UNAVAILABLE = "Follow My Voice isn't available in this desktop app — it works in the browser version.";

function desktopListens(): boolean {
  return ports.desktop.running() && ports.voice.available();
}

function voiceIdleLabel(): string {
  if (ports.desktop.running() && !desktopListens() && ports.desktop.canOpen()) return VOICE_BROWSER_LABEL;
  return VOICE_IDLE_LABEL;
}

export function updateVoiceAvailability(): void {
  const btn = document.getElementById("pp-voice") as HTMLButtonElement | null;
  if (!btn) return;
  if (ports.desktop.running() && !ports.voice.known()) {
    btn.disabled = true;
    const owner = ports;
    ports.voice.load().then(function () { if (ports === owner) updateVoiceAvailability(); });
    return;
  }
  if (!ports.state.voiceFollowing()) setVoiceLabel(btn, voiceIdleLabel());
  if (ports.desktop.running()) {
    if (desktopListens()) {
      btn.disabled = false;
      if (!ports.state.voiceFollowing() && !voiceStarting) setVoiceStatus("", "");
    } else if (ports.desktop.canOpen()) {
      btn.disabled = false;
      setVoiceStatus("Chrome or Edge can follow your voice — this opens the saved script there.", "");
    } else {
      btn.disabled = true;
      setVoiceStatus(VOICE_DESKTOP_UNAVAILABLE, "");
    }
  } else if (ports.voice.hasRelay()) {
    btn.disabled = false;
    if (!ports.state.voiceFollowing() && !voiceStarting) setVoiceStatus("", "");
  } else if (!ports.voice.browserRecognition()) {
    btn.disabled = true;
    setVoiceStatus("Voice follow needs Chrome or Edge.", "");
  } else if (!window.isSecureContext) {
    btn.disabled = true;
    setVoiceStatus("Voice follow needs the app served over http:// — start it with start.bat.", "");
  } else {
    btn.disabled = false;
    if (!ports.state.voiceFollowing()) setVoiceStatus("", "");
  }
}

function updateVoiceButtonUI(): void {
  const btn = document.getElementById("pp-voice");
  if (!btn) return;
  btn.classList.toggle("is-active", ports.state.voiceFollowing());
  setVoiceLabel(btn, ports.state.voiceFollowing() ? "Stop Following" : voiceIdleLabel());
  const scroller = document.getElementById("prompter-scroll");
  if (scroller) scroller.classList.toggle("is-following", !!ports.state.voiceFollowing());
  syncVoiceState();
}

function applySpokenUpTo(idx: number): void {
  for (let i = 0; i < promptWords.length; i++) {
    const el = (promptWords[i] as PromptWord).el;
    el.classList.toggle("spoken", i < idx);
    el.classList.toggle("current-word", i === idx);
  }
}

function clearSpokenHighlights(): void {
  promptWords.forEach(function (w) {
    w.el.classList.remove("spoken");
    w.el.classList.remove("current-word");
  });
}

function scrollWordIntoView(idx: number): void {
  const w = promptWords[idx];
  if (!w) return;
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  scroller.scrollTo({ top: Math.max(0, w.el.offsetTop - scroller.clientHeight / 2), behavior: "smooth" });
}

function findBestMatch(recentWords: string[], scriptNorms: string[], searchStart: number, searchEnd: number): { index: number; score: number } {
  const n = recentWords.length;
  let bestScore = 0, bestIndex = -1;
  for (let end = searchStart; end <= searchEnd; end++) {
    let score = 0;
    for (let k = 1; k <= n && (end - k + 1) >= 0; k++) {
      if (scriptNorms[end - k + 1] === recentWords[n - k]) score++;
      else break;
    }
    if (score > bestScore) { bestScore = score; bestIndex = end; }
  }
  return { index: bestIndex, score: bestScore };
}

function onSpeechTranscript(): void {
  const combined = (finalTranscript + " " + interimTranscript).trim();
  const words = combined.split(/\s+/).map(normalizeWord).filter(Boolean);
  const recent = words.slice(-8);
  if (!recent.length || !speakNorms.length) return;

  const searchStart = Math.max(0, speakCursor - 40);
  const searchEnd = Math.min(speakNorms.length - 1, speakCursor + 80);
  const best = findBestMatch(recent, speakNorms, searchStart, searchEnd);

  if (best.index !== -1 && best.index !== speakCursor &&
      best.score >= (best.index > speakCursor ? 2 : 3)) {
    speakCursor = best.index;
    wordCursor = speakable[speakCursor] as number;
    applySpokenUpTo(wordCursor);
    scrollWordIntoView(wordCursor);
    if (promptSceneMode && promptSceneIndex !== -1 && wordCursor >= (sceneWordEnd[promptSceneIndex] as number)) {
      stopVoiceFollow();
      advanceSceneAfterAutoPause();
      setVoiceStatus("Scene finished — say it again to keep following, or press Next.", "listening");
    }
  }

  if (finalTranscript.length > 4000) finalTranscript = finalTranscript.slice(-1200);

  if (speakCursor >= speakNorms.length - 1) {
    setVoiceStatus("Reached the end", "listening");
  } else if (ports.state.voiceFollowing()) {
    setVoiceStatus(listeningStatus("Listening"), "listening");
  }
}

function releaseVoiceStream(): void {
  if (!voiceStream) return;
  try { voiceStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  voiceStream = null;
}

const DESKTOP_VOICE_WARNINGS: Record<string, () => string> = {
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
const CLEARABLE_VOICE_WARNINGS = ["no-signal", "too-quiet", "blocked-all", "blocked-desktop"];

export async function startVoiceFollow(): Promise<void> {
  const owner = ports;
  const requestedSession = voiceSession;
  const desktop = ports.desktop.running();
  if (desktop && !ports.voice.known()) {
    try { await ports.voice.load(); }
    catch (error) {
      if (ports !== owner || requestedSession !== voiceSession) return;
      throw error;
    }
  }
  if (ports !== owner || requestedSession !== voiceSession) return;
  if (desktop && !desktopListens()) {
    if (!ports.desktop.canOpen()) { setVoiceStatus(VOICE_DESKTOP_UNAVAILABLE, ""); return; }
    setVoiceStatus("Opening in your browser…", "");
    ports.desktop.open().then(function (result) {
      if (ports !== owner || requestedSession !== voiceSession) return;
      if (result && result.message) setVoiceStatus(result.message, result.ok ? "" : "error");
    });
    return;
  }
  const relayed = !desktop && ports.voice.hasRelay();
  if (!desktop && !relayed && !ports.voice.browserRecognition()) return;
  if (ports.state.voiceFollowing() || voiceStarting) return;
  if (!speakNorms.length) {
    setVoiceStatus("Nothing to read yet.", "error");
    return;
  }
  voiceStarting = true;
  const mySession = ++voiceSession;
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
    let receivedStream: MediaStream;
    try {
      receivedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (ports !== owner || mySession !== voiceSession) return;
      voiceStarting = false;
      const name = err && (err as { name?: unknown }).name;
      setVoiceStatus(
        name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No microphone was found."
          : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.",
        "error");
      return;
    }
    if (ports !== owner || mySession !== voiceSession) {
      try { receivedStream.getTracks().forEach(function (track) { track.stop(); }); } catch (e) {}
      return;
    }
    voiceStream = receivedStream;
    try {
      const track = voiceStream.getAudioTracks()[0];
      voiceMicName = (track && track.label) || "";
    } catch (e) {}
  }

  try {
    recognition = (desktop ? ports.voice.createDesktop()
      : relayed ? ports.voice.createRelay()
      : new (ports.voice.browserRecognition() as new () => PrompterRecognition)()) as VoiceRecognition;
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
      if (ports !== owner || mySession !== voiceSession) return;
      if (e && e.warning === "clear") {
        const el = document.getElementById("pp-voice-status");
        if (ports.state.voiceFollowing() && el) {
          for (let i = 0; i < CLEARABLE_VOICE_WARNINGS.length; i++) {
            if (el.textContent === (DESKTOP_VOICE_WARNINGS[CLEARABLE_VOICE_WARNINGS[i] as string] as () => string)()) {
              setVoiceStatus(listeningStatus("Listening…"), "listening");
              break;
            }
          }
        }
        return;
      }
      const warn = DESKTOP_VOICE_WARNINGS[(e && e.warning) as string];
      if (warn && ports.state.voiceFollowing()) setVoiceStatus(warn(), "error");
    };
    recognition.ondevice = function (e) {
      if (ports !== owner || mySession !== voiceSession) return;
      voiceMicName = (e && typeof e.name === "string") ? e.name : "";
    };
  }
  recognition.onstart = function () {
    if (ports !== owner || mySession !== voiceSession) return;
    voiceStarting = false;
    ports.state.setVoiceFollowing(true);
    updateVoiceButtonUI();
    setVoiceStatus(listeningStatus("Listening…"), "listening");
  };
  recognition.onresult = function (e) {
    if (ports !== owner || mySession !== voiceSession) return;
    let finalChunk = "", interimChunk = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i] as PrompterSpeechResult;
      if (r.isFinal) finalChunk += r[0].transcript + " ";
      else interimChunk += r[0].transcript + " ";
    }
    if (finalChunk) finalTranscript += finalChunk;
    interimTranscript = interimChunk;
    voiceRestarts = 0;
    onSpeechTranscript();
  };
  recognition.onerror = function (e) {
    if (ports !== owner || mySession !== voiceSession) return;
    voiceStarting = false;
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      setVoiceStatus(desktop || relayed
        ? "Microphone blocked — let desktop apps use it in Settings › Privacy & security › Microphone, then try again."
        : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.", "error");
      ports.state.setVoiceFollowing(false);
    } else if (e.error === "no-recognizer") {
      setVoiceStatus("Windows has no speech recogniser installed. Add one in Settings › Time & language › Speech, or use Present in Browser.", "error");
      ports.state.setVoiceFollowing(false);
    } else if (e.error === "taken") {
      setVoiceStatus("Another tab is following your voice now.", "");
      ports.state.setVoiceFollowing(false);
    } else if (e.error === "helper-failed" || e.error === "unavailable") {
      setVoiceStatus("Windows speech recognition couldn't start. Present in Browser still works.", "error");
      ports.state.setVoiceFollowing(false);
    } else if (e.error === "relay-lost") {
      setVoiceStatus("Lost the Splitpage desktop app — open the teleprompter from it again to follow your voice.", "error");
      ports.state.setVoiceFollowing(false);
    } else if (e.error === "audio-capture") {
      setVoiceStatus("No microphone was found.", "error");
      ports.state.setVoiceFollowing(false);
    } else if (e.error === "network") {
      setVoiceStatus("Speech recognition needs an internet connection.", "error");
    } else {
      setVoiceStatus("Voice follow hit an error (" + e.error + ").", "error");
    }
    updateVoiceButtonUI();
  };
  recognition.onend = function () {
    if (ports !== owner || mySession !== voiceSession) return;
    if (mySession !== voiceSession || !ports.state.voiceFollowing()) {
      if (mySession === voiceSession) releaseVoiceStream();
      updateVoiceButtonUI();
      return;
    }
    voiceRestarts++;
    if (voiceRestarts > 40) {
      ports.state.setVoiceFollowing(false);
      releaseVoiceStream();
      updateVoiceButtonUI();
      setVoiceStatus("Voice follow kept dropping out — stopped.", "error");
      return;
    }
    setTimeout(function () {
      if (ports !== owner || mySession !== voiceSession || !ports.state.voiceFollowing() || !recognition) return;
      try { recognition.start(); }
      catch (e) {
        ports.state.setVoiceFollowing(false);
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

export function stopVoiceFollow(): void {
  const wasActive = ports.state.voiceFollowing();
  voiceSession++;
  ports.state.setVoiceFollowing(false);
  voiceStarting = false;
  if (recognition) {
    try {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onstart = null;
      recognition.onerror = null;
      recognition.onwarning = null;
      recognition.ondevice = null;
      recognition.stop();
    } catch (e) {}
    recognition = null;
  }
  releaseVoiceStream();
  updateVoiceButtonUI();
  if (wasActive) setVoiceStatus("", "");
}

const PROMPTER_LAUNCH_KEY = "splitpage-prompter-launch";
const PROMPTER_TOKEN_RE = /^[0-9a-f]{64}$/;

function readPrompterLaunch(): PrompterLaunch | null {
  if (ports.desktop.running()) return null;
  let wanted: boolean;
  try { wanted = new URLSearchParams(location.search).get("teleprompter") === "1"; } catch (e) { wanted = false; }
  const m = /(?:^#|&)script=([0-9a-f]{64})(?=&|$)/.exec(location.hash || "");
  const token = m ? m[1] as string : "";
  const v = /(?:^#|&)voice=(\d{1,5}-[0-9a-f]{64})(?=&|$)/.exec(location.hash || "");
  if (wanted || token) ports.voice.setRelay(v ? v[1] as string : "");
  else ports.voice.setRelay(null);
  if (wanted || token) {
    try {
      const url = new URL(location.href);
      url.searchParams.delete("teleprompter");
      let rest = (url.hash || "").replace(/(^#|&)script=[0-9a-f]{64}/, "$1").replace(/^#&/, "#")
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
  let kept: string;
  try { kept = sessionStorage.getItem(PROMPTER_LAUNCH_KEY) || ""; } catch (e) { kept = ""; }
  return PROMPTER_TOKEN_RE.test(kept) ? { token: kept } : null;
}

function whenInitialStateReady(): Promise<unknown> {
  const owner = ports;
  return new Promise(function (resolve) {
    (function check() {
      if (ports !== owner) return;
      const ready = ports.startup.ready();
      if (ready) ready.then(resolve, resolve);
      else initialReadyTimer = setTimeout(check, 50);
    })();
  });
}

function showPrompterForLaunch(): void {
  ports.panels.close("newtab-page");
  if (!ports.state.isOpen()) openPrompter();
}

async function launchPrompterFromScript(token: string): Promise<boolean> {
  const owner = ports;
  let body: { name?: unknown; text?: unknown } | null = null;
  try {
    const res = await fetch("prompter-script/" + token, { cache: "no-store", credentials: "same-origin" });
    if (res.ok) body = await res.json() as { name?: unknown; text?: unknown };
  } catch (e) { body = null; }
  if (ports !== owner) return false;
  if (!body || typeof body.name !== "string" || typeof body.text !== "string") {
    try { sessionStorage.removeItem(PROMPTER_LAUNCH_KEY); } catch (e) {}
    ports.notices.show("This teleprompter link has expired — open it again from the Splitpage desktop app " +
              "(File ▸ Present in browser).", "warn", true);
    return false;
  }
  const file = new File([body.text], body.name, { type: "text/plain" });
  let parsed: unknown;
  try { parsed = await ports.files.parse(file); }
  catch (error) {
    if (ports !== owner) return false;
    throw error;
  }
  if (ports !== owner) return false;
  if (!parsed || (parsed as { error?: unknown }).error) {
    ports.notices.show("Could not read the script the desktop app sent.", "error", true);
    return false;
  }
  ports.opening.open({ kind: "file", file: file, handle: null, parsed: parsed, options: { skipSnapshot: true, silent: true } });
  showPrompterForLaunch();
  ports.notices.show("A copy from the desktop app, for reading — edit the script there; changes made here are not saved back.", "ok");
  return true;
}

function startPrompterLaunch(launch: PrompterLaunch): void {
  const owner = ports;
  ports.preferences.skipOnboardingForPrompter();
  whenInitialStateReady().then(function () {
    if (ports !== owner) return;
    if (launch.token) return launchPrompterFromScript(launch.token);
  });
}

export function wireTagEntityContainer(id: string, rootClick: (event: MouseEvent) => void): () => void {
  return ports.installTagEntityContainer(id, rootClick);
}

export function startPrompter(nextPorts: PrompterFeaturePorts): PrompterRuntime {
  ports = nextPorts;
  prompterMirror = ports.preferences.prompterFlag("prompterMirror");

  prompterFlip = ports.preferences.prompterFlag("prompterFlip");

  promptSceneMode = ports.preferences.prompterFlag("prompterSceneMode");

  (window as PrompterWindow).__prompterTest = {
    checkSceneBoundaryNow: function () {
      const scroller = document.getElementById("prompter-scroll") as HTMLElement;
      if (!promptSceneMode || promptSceneEndWordOffset == null) return false;
      if (!scenePastReadingLine(scroller.scrollTop, promptSceneEndWordOffset, promptSceneGuideOffset)) return false;
      setPrompterPlaying(false);
      advanceSceneAfterAutoPause();
      return true;
    },
    simulateVoiceWordCursor: function (idx) {
      wordCursor = idx;
      if (!promptSceneMode || promptSceneIndex === -1 || wordCursor < (sceneWordEnd[promptSceneIndex] as number)) return false;
      stopVoiceFollow();
      advanceSceneAfterAutoPause();
      return true;
    },
    launchFromScript: launchPrompterFromScript,
    updateStatus: updatePrompterStatus
  };

  const launch = readPrompterLaunch();
  if (launch) startPrompterLaunch(launch);

  return {
    openPrompter, closePrompter, stopVoiceFollow, startVoiceFollow,
    setPrompterPlaying, setPrompterSpeed, applyPrompterSize, stepPrompterSpeed, stepPrompterSize,
    updatePrompterStatus, buildPrompterContent, updateVoiceAvailability,
    cueSceneForCurrentPosition, updateSceneReadout, setPrompterMirror, setPrompterFlip,
    setPrompterSceneMode, stepScene, acquireWakeLock, wireTagEntityContainer,
    disposeRuntime: disposePrompterView,
    voiceActive: function () { return ports.state.voiceFollowing(); },
    playing: function () { return ports.state.isPlaying(); },
    isOpen: function () { return ports.state.isOpen(); },
    skipShot: function () { return ports.state.skipsShot(); },
    setSkipShot: function (value) { ports.state.setSkipShot(value); },
    mirror: function () { return prompterMirror; },
    flip: function () { return prompterFlip; },
    sceneMode: function () { return promptSceneMode; },
    dispose: function () {
      if (ports !== nextPorts) return;
      disposePrompterView();
      clearTimeout(initialReadyTimer as TimerHandle);
      initialReadyTimer = null;
      delete (window as PrompterWindow).__prompterTest;
      (ports as unknown) = null;
    }
  };
}
