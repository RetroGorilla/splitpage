import { endsSentence } from "../../core/text/sentences.ts";
import { flowOf } from "../../core/flow/flow.ts";
import { numberHtml } from "../common/number-html.ts";
import { formatTimecode, rowSeconds } from "../../core/production/timing.ts";
import { withoutCues } from "../../core/text/cues.ts";
import { sliceCell } from "../../core/text/edits.ts";
import { toHtml } from "../../core/text/html.ts";
import { toPlainText } from "../../core/text/projections.ts";
import { projection } from "../../core/text/runs.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { CellInput, Run } from "../../core/text/runs.ts";
import type { PrompterRecognition } from "../../application/prompter-services.ts";
import { microphoneChoices } from "../../application/microphones.ts";
import type { MicrophoneChoice } from "../../application/microphones.ts";
import type { PrompterFeaturePorts, PrompterRuntime } from "./ports.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

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
type PrompterDoc = Pick<DocumentView, "rows"> & {
  readonly wordsPerMinute?: number | null | undefined;
  readonly sections?: unknown;
};
type PromptWord = { el: HTMLElement; norm: string };
type BeatView = { html: string; words: number };
type BeatEntry = { id: string; cell: Run[]; view: BeatView | null };
type BeatLine = BeatEntry & { view: BeatView };
type PrompterLaunch = { token?: string; hosted?: boolean };
type PrompterTestHooks = {
  checkSceneBoundaryNow: () => boolean;
  simulateVoiceWordCursor: (idx: number) => boolean;
  launchFromScript: (token: string) => Promise<boolean>;
  updateStatus: () => void;
};

interface PrompterState {
  prompterSpeed: number;
  prompterRAF: number | null;
  prompterLastTs: number | null;
  recognition: VoiceRecognition | null;
  voiceStarting: boolean;
  promptWords: PromptWord[];
  wordCursor: number;
  speakable: number[];
  speakNorms: string[];
  speakCursor: number;
  voiceRestarts: number;
  voiceStream: MediaStream | null;
  voiceTrack: MediaStreamTrack | null;
  voiceMicFellBack: boolean;
  finalTranscript: string;
  interimTranscript: string;
  beatSeconds: number[];
  beatStartSec: number[];
  promptTotalSec: number;
  rundownBlockEls: (HTMLElement | null)[];
  rundownBlockIndex: number[];
  paintedBeat: number;
  promptLinePx: number;
  prompterWakeLock: WakeLockSentinel | null;
  beatRowIds: string[];
  beatScenes: string[];
  beatWordStart: number[];
  beatWordEnd: number[];
  promptBeatIndex: number;
  promptBeatEndWordOffset: number | null;
  promptBeatGuideOffset: number;
  promptSizeDefaultSet: number | null;
  voiceMicName: string;
  promptBeatMode: boolean | undefined;
}

function freshState(): PrompterState {
  return {
    prompterSpeed: 42,
    prompterRAF: null,
    prompterLastTs: null,
    recognition: null,
    voiceStarting: false,
    promptWords: [],
    wordCursor: -1,
    speakable: [],
    speakNorms: [],
    speakCursor: -1,
    voiceRestarts: 0,
    voiceStream: null,
    voiceTrack: null,
    voiceMicFellBack: false,
    finalTranscript: "",
    interimTranscript: "",
    beatSeconds: [],
    beatStartSec: [],
    promptTotalSec: 0,
    rundownBlockEls: [],
    rundownBlockIndex: [],
    paintedBeat: -2,
    promptLinePx: 60 * 1.42,
    prompterWakeLock: null,
    beatRowIds: [],
    beatScenes: [],
    beatWordStart: [],
    beatWordEnd: [],
    promptBeatIndex: -1,
    promptBeatEndWordOffset: null,
    promptBeatGuideOffset: 0,
    promptSizeDefaultSet: null,
    voiceMicName: "",
    promptBeatMode: undefined
  };
}

let ports: PrompterFeaturePorts;
const state = freshState();
let initialReadyTimer: TimerHandle | null = null;
let voiceSession = 0;
let wakeLockGen = 0;
let prompterLeaveSeq = 0;
let searching = false;
let voiceFromReadingLine = false;
const viewListeners = new Set<() => void>();
let prompterReturnFocus: HTMLElement | null = null;

export let prompterMirror: boolean;
export let prompterFlip: boolean;

function normalizeWord(w: unknown): string {
  return String(w || "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

export function prompterBeatHtml(cell: CellInput): BeatView {
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


export function buildPrompterContent(): void {
  const skippingShot = ports.state.skipsShot() || ports.viewFlags.hideShot();
  const doc = ports.document.current() as PrompterDoc;
  const membership = new Map<string, number>();
  flowOf({ ...doc, comments: [] }).forEach((block, index) => {
    if (block.kind === "paragraph") for (const beat of block.beats) membership.set(beat.id, index);
  });
  const source = skippingShot
    ? doc.rows.filter(function (row) { return row.status !== "shot"; })
    : doc.rows;
  const beatEntries = source.map(function (row): BeatEntry {
    const cell = trimPrompterCell(withoutCues(ports.text.cellOf(row.audioText)));
    return { id: row.id, cell: cell, view: cell.length ? prompterBeatHtml(cell) : null };
  });
  const lines = beatEntries.filter(function (e) { return e.view; }) as BeatLine[];

  const paragraphs: string[] = [];
  lines.forEach(function (e, i) {
    const prevEndsSentence = i === 0 || endsSentence(toPlainText((lines[i - 1] as BeatLine).cell));
    const startsParagraph = i === 0 || membership.get(e.id) !== membership.get((lines[i - 1] as BeatLine).id);
    if (prevEndsSentence || startsParagraph) paragraphs.push(e.view.html);
    else paragraphs[paragraphs.length - 1] += " " + e.view.html;
  });

  const content = document.getElementById("prompter-content") as HTMLElement;
  if (!paragraphs.length) {
    content.innerHTML = '<div class="prompter-empty">' + (skippingShot
      ? "Every beat is marked Filmed — switch off Skip filmed (or Hide filmed beats) to read them again."
      : "Nothing to read yet — add some audio text first.") + '</div>';
    state.promptWords = [];
  } else {
    content.innerHTML = paragraphs.map(function (html) {
      return '<div class="prompter-line">' + html + '</div>';
    }).join("");
    state.promptWords = Array.prototype.map.call(content.querySelectorAll(".w"), function (el: HTMLElement): PromptWord {
      return { el: el, norm: normalizeWord(el.textContent) };
    }) as PromptWord[];
  }
  state.speakable = [];
  state.speakNorms = [];
  state.promptWords.forEach(function (w, i) {
    if (!w.norm) return;
    state.speakable.push(i);
    state.speakNorms.push(w.norm);
  });
  state.wordCursor = -1;
  state.speakCursor = -1;

  state.beatRowIds = [];
  state.beatScenes = [];
  const sceneNames = new Map<string, string>();
  for (const group of ports.document.numbering().scenes) {
    for (let i = group.start; i < group.end; i++) sceneNames.set((doc.rows[i] as { id: string }).id, group.letter + (group.name ? " " + group.name : ""));
  }
  state.beatWordStart = [];
  state.beatWordEnd = [];
  let cursor = 0;
  beatEntries.forEach(function (e) {
    const n = e.view ? e.view.words : 0;
    state.beatRowIds.push(e.id);
    state.beatScenes.push(sceneNames.get(e.id) ?? "");
    state.beatWordStart.push(cursor);
    cursor += n;
    state.beatWordEnd.push(cursor);
  });
  state.promptBeatIndex = -1;
  state.promptBeatEndWordOffset = null;

  state.beatSeconds = [];
  state.beatStartSec = [];
  let t = 0;
  source.forEach(function (row) {
    const secs = rowSeconds(row, doc, ports.text.productionReaders);
    state.beatStartSec.push(t);
    state.beatSeconds.push(secs);
    t += secs;
  });
  state.promptTotalSec = t;
  renderPrompterRundown();
  const skip = document.getElementById("pp-skip-shot");
  if (skip) skip.setAttribute("aria-pressed", ports.state.skipsShot() ? "true" : "false");
  voiceFromReadingLine = false;
  for (const listener of viewListeners) listener();
}

function renderPrompterRundown(): void {
  const track = document.getElementById("pp-rd-track");
  if (!track) return;
  let html = "";
  let count = 0;
  state.rundownBlockIndex = state.beatSeconds.map(function (secs) {
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
  state.rundownBlockEls = state.beatSeconds.map(function (secs, i) {
    return secs > 0 ? els[state.rundownBlockIndex[i] as number] as HTMLElement : null;
  });
  state.paintedBeat = -2;
}

function readingPosition(scroller: HTMLElement): number {
  const words = state.promptWords;
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
    if ((words[mid] as PromptWord).el.offsetTop >= top - state.promptLinePx / 2) hi = mid; else lo = mid + 1;
  }
  const next = last + 1;
  const nextTop = next < n ? (words[next] as PromptWord).el.offsetTop : top + state.promptLinePx;
  const frac = nextTop > top ? Math.min(1, Math.max(0, (guide - top) / (nextTop - top))) : 0;
  return lo + frac * (next - lo);
}

function beatAtWord(pos: number): number {
  const w = Math.min(Math.floor(pos), state.promptWords.length - 1);
  let lo = 0, hi = state.beatWordEnd.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((state.beatWordEnd[mid] as number) > w) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

export function updatePrompterStatus(): void {
  if (!ports.state.isOpen()) return;
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  let beat = -1, elapsed = 0;
  if (state.promptWords.length && state.beatRowIds.length) {
    const pos = readingPosition(scroller);
    beat = beatAtWord(pos);
    const span = (state.beatWordEnd[beat] as number) - (state.beatWordStart[beat] as number);
    const into = span > 0 ? Math.min(1, Math.max(0, (pos - (state.beatWordStart[beat] as number)) / span)) : 0;
    elapsed = (state.beatStartSec[beat] as number) + (state.beatSeconds[beat] as number) * into;
  }

  const posEl = document.getElementById("pp-scene-pos");
  const number = ports.document.numbering().beats[state.beatRowIds[beat] ?? ""]?.full ?? "";
  if (posEl && posEl.textContent !== number) posEl.innerHTML = numberHtml(number);
  setText(document.getElementById("pp-scene-pos-sr"), beat === -1 ? "" : "Beat " + number + ", " + state.beatRowIds.length + " beats");
  setText(document.getElementById("pp-scene-start"), beat === -1 ? "" : formatTimecode(state.beatStartSec[beat] as number));
  const sceneEl = document.getElementById("pp-section");
  const sceneName = beat === -1 ? "" : state.beatScenes[beat] ?? "";
  if (sceneEl) { setText(sceneEl, sceneName); sceneEl.hidden = !sceneName; sceneEl.title = sceneName; }
  const read = Math.round(elapsed);
  const total = Math.round(state.promptTotalSec);
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
  if (!track || !state.promptTotalSec) return;
  if (beat !== state.paintedBeat) {
    state.rundownBlockEls.forEach(function (el, i) {
      if (!el) return;
      el.classList.toggle("is-played", i < beat);
      el.classList.toggle("is-current", i === beat);
    });
    state.paintedBeat = beat;
  }
  const cur = beat === -1 ? null : state.rundownBlockEls[beat];
  if (cur) cur.style.setProperty("--p", ((state.beatSeconds[beat] as number) ? (elapsed - (state.beatStartSec[beat] as number)) / (state.beatSeconds[beat] as number) * 100 : 0) + "%");
  track.style.setProperty("--pp-at", String(Math.min(1, elapsed / state.promptTotalSec)));
  track.style.setProperty("--pp-i", String(beat === -1 ? 0 : state.rundownBlockIndex[beat]));
}

export function acquireWakeLock(owns?: () => boolean): void {
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  const gen = ++wakeLockGen;
  navigator.wakeLock.request("screen").then(function (lock) {
    if (gen !== wakeLockGen || !ports.state.isOpen() || (owns && !owns())) { lock.release().catch(function () {}); return; }
    state.prompterWakeLock = lock;
  }).catch(function () { });
}

function releaseWakeLock(): void {
  wakeLockGen++;
  if (state.prompterWakeLock) {
    state.prompterWakeLock.release().catch(function () {});
    state.prompterWakeLock = null;
  }
}

export function disposePrompterView(): void {
  setPrompterPlaying(false);
  stopVoiceFollow();
  releaseWakeLock();
  prompterReturnFocus = null;
  searching = false;
  voiceFromReadingLine = false;
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

function beatPastReadingLine(scrollTop: number, wordTop: number, guideTop: number): boolean {
  return (wordTop - scrollTop) <= guideTop;
}

export function updateBeatReadout(): void {
  const el = document.getElementById("pp-scene-readout");
  if (!el) return;
  if (!state.promptBeatMode || state.promptBeatIndex === -1 || !state.beatRowIds.length) { el.textContent = ""; return; }
  el.textContent = "Beat " + (ports.document.numbering().beats[state.beatRowIds[state.promptBeatIndex] ?? ""]?.full ?? "") + " of " + state.beatRowIds.length;
}

function updatePrompterBeatModeUI(): void {
  setToggle(document.getElementById("pp-scene-mode"), !!state.promptBeatMode);
  ["pp-scene-step", "pp-scene-prev", "pp-scene-next", "pp-scene-readout"].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.hidden = !state.promptBeatMode;
  });
  updateBeatReadout();
}

function findNonEmptyBeatIndex(from: number, dir: number): number {
  for (let i = from; i >= 0 && i < state.beatRowIds.length; i += dir) {
    if ((state.beatWordEnd[i] as number) > (state.beatWordStart[i] as number)) return i;
  }
  return -1;
}

function cueBeat(idx: number): boolean {
  if (idx < 0 || idx >= state.beatRowIds.length) return false;
  if ((state.beatWordEnd[idx] as number) <= (state.beatWordStart[idx] as number)) return false;
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  const firstWord = (state.promptWords[state.beatWordStart[idx] as number] as PromptWord).el;
  const lastWord = (state.promptWords[(state.beatWordEnd[idx] as number) - 1] as PromptWord).el;
  state.promptBeatIndex = idx;
  state.promptBeatGuideOffset = scroller.clientHeight / 2;
  scroller.scrollTop = Math.max(0, firstWord.offsetTop - state.promptBeatGuideOffset);
  state.promptBeatEndWordOffset = lastWord.offsetTop;
  updateBeatReadout();
  updatePrompterStatus();
  return true;
}

export function stepBeat(dir: number): void {
  if (!state.promptBeatMode || !state.beatRowIds.length) return;
  const next = findNonEmptyBeatIndex(state.promptBeatIndex + dir, dir);
  if (next === -1) return;
  setPrompterPlaying(false);
  cueBeat(next);
}

export function cueBeatForCurrentPosition(): void {
  if (!state.beatRowIds.length) { state.promptBeatIndex = -1; state.promptBeatEndWordOffset = null; updateBeatReadout(); return; }
  const lastRow = ports.focus.lastRow();
  let idx = lastRow ? state.beatRowIds.indexOf(lastRow) : -1;
  if (idx === -1) idx = 0;
  let resolved = findNonEmptyBeatIndex(idx, 1);
  if (resolved === -1) resolved = findNonEmptyBeatIndex(idx, -1);
  if (resolved === -1) { state.promptBeatIndex = -1; state.promptBeatEndWordOffset = null; updateBeatReadout(); return; }
  cueBeat(resolved);
}

function advanceBeatAfterAutoPause(): void {
  const next = findNonEmptyBeatIndex(state.promptBeatIndex + 1, 1);
  if (next === -1) { state.promptBeatEndWordOffset = null; return; }
  state.promptBeatIndex = next;
  state.promptBeatEndWordOffset = (state.promptWords[(state.beatWordEnd[next] as number) - 1] as PromptWord).el.offsetTop;
  updateBeatReadout();
}

export function setPrompterBeatMode(on: boolean): void {
  on = !!on;
  if (on === state.promptBeatMode) return;
  state.promptBeatMode = on;
  ports.preferences.setPrompterFlag("prompterSceneMode", on);
  updatePrompterBeatModeUI();
  if (on) cueBeatForCurrentPosition();
  else { state.promptBeatIndex = -1; state.promptBeatEndWordOffset = null; }
}

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
  if (!ports.state.isOpen()) prompterReturnFocus = document.activeElement as HTMLElement | null;
  ports.panels.closeAll();
  buildPrompterContent();
  const el = document.getElementById("prompter") as HTMLElement;
  prompterLeaveSeq++;
  el.classList.remove("is-holding");
  el.inert = false;
  el.hidden = false;
  ports.state.setOpen(true);
  hearMicrophones();
  lockPageScrollWhenArrived(el);
  (document.getElementById("prompter-scroll") as HTMLElement).scrollTop = 0;
  setPrompterPlaying(false);
  applyPrompterDefaultSize();
  applyPrompterSize();
  applyPrompterOrientation();
  updatePrompterBeatModeUI();
  if (state.promptBeatMode) cueBeatForCurrentPosition();
  updateVoiceAvailability();
  syncSpeedReadout();
  updatePrompterStatus();
  document.getElementById("pp-play")?.focus({ preventScroll: true });
  acquireWakeLock();
  for (const listener of viewListeners) listener();
}

export function closePrompter(): void {
  setPrompterPlaying(false);
  stopVoiceFollow();
  stopHearingMicrophones();
  ports.state.setOpen(false);
  for (const listener of viewListeners) listener();
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
  const origin = prompterReturnFocus;
  prompterReturnFocus = null;
  if (document.activeElement === document.body && origin?.isConnected && origin !== document.body &&
      !origin.closest("[hidden], [inert]") && !origin.matches(":disabled")) origin.focus({ preventScroll: true });
}

export function setPrompterPlaying(on: boolean): void {
  if (on && searching) return;
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
    state.prompterLastTs = null;
    state.prompterRAF = requestAnimationFrame(prompterTick);
  } else if (state.prompterRAF) {
    cancelAnimationFrame(state.prompterRAF);
    state.prompterRAF = null;
  }
}

function prompterTick(ts: number): void {
  const scroller = document.getElementById("prompter-scroll") as HTMLElement;
  if (state.prompterLastTs == null) state.prompterLastTs = ts;
  const dt = (ts - state.prompterLastTs) / 1000;
  state.prompterLastTs = ts;
  scroller.scrollTop += state.prompterSpeed * dt;
  if (state.promptBeatMode && state.promptBeatEndWordOffset != null &&
      beatPastReadingLine(scroller.scrollTop, state.promptBeatEndWordOffset, state.promptBeatGuideOffset)) {
    setPrompterPlaying(false);
    advanceBeatAfterAutoPause();
    return;
  }
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    setPrompterPlaying(false);
    return;
  }
  state.prompterRAF = requestAnimationFrame(prompterTick);
}

export function applyPrompterSize(): void {
  const size = Number((document.getElementById("pp-size") as HTMLInputElement).value);
  (document.getElementById("prompter") as HTMLElement).style.setProperty("--pp-size", size + "px");
  state.promptLinePx = size * 1.42;
  setText(document.getElementById("pp-size-value"), String(size));
  updatePrompterStatus();
}

const PROMPTER_SIZE_DEFAULT = 60;
const PROMPTER_SIZE_PHONE = 36;

function applyPrompterDefaultSize(): void {
  const input = document.getElementById("pp-size") as HTMLInputElement;
  if (state.promptSizeDefaultSet !== null && Number(input.value) !== state.promptSizeDefaultSet) return;
  const phone = window.matchMedia && window.matchMedia("(max-width: 760px)").matches;
  state.promptSizeDefaultSet = phone ? PROMPTER_SIZE_PHONE : PROMPTER_SIZE_DEFAULT;
  input.value = String(state.promptSizeDefaultSet);
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
  state.prompterSpeed = Math.max(Number(input.min), Math.min(Number(input.max), Math.round(value)));
  input.value = String(state.prompterSpeed);
  syncSpeedReadout();
}

export function stepPrompterSpeed(dir: number): void {
  setPrompterSpeed(state.prompterSpeed + dir * PROMPTER_SPEED_STEP);
}

function syncSpeedReadout(): void {
  setText(document.getElementById("pp-speed-value"), (state.prompterSpeed / PROMPTER_SPEED_BASE).toFixed(1) + "×");
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

function listeningStatus(fallback: string): string {
  if (!state.voiceMicName) return fallback;
  return "Listening — " + state.voiceMicName + (state.voiceMicFellBack ? MIC_FELL_BACK_NOTE : "");
}

const MIC_FELL_BACK_NOTE = " (your chosen microphone isn't connected)";
const MIC_ENDED_MESSAGE = "Your chosen microphone stopped working — pick it again or choose another.";
let micListing = 0;

function renderMicrophoneChoices(select: HTMLSelectElement, choices: readonly MicrophoneChoice[]): void {
  select.replaceChildren(...choices.map(function (choice) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    return option;
  }));
  select.value = ports.preferences.microphone();
}

function refreshMicrophoneChoices(): void {
  const select = document.getElementById("pp-mic") as HTMLSelectElement | null;
  if (!select || select.hidden) return;
  const owner = ports;
  const ticket = ++micListing;
  ports.microphones.list().then(function (list) {
    if (ports !== owner || ticket !== micListing) return;
    renderMicrophoneChoices(select, microphoneChoices(ports.preferences.microphone(), list));
  });
}

function syncMicrophoneSelect(): void {
  const select = document.getElementById("pp-mic") as HTMLSelectElement | null;
  if (!select) return;
  select.hidden = ports.microphones.support() !== "yes";
  refreshMicrophoneChoices();
}

let hearingMicrophones: (() => void) | null = null;

function hearMicrophones(): void {
  if (hearingMicrophones) return;
  const owner = ports;
  const stopPreferences = ports.changes.onChange(function (change) {
    if (ports !== owner || change.name !== "microphone") return;
    refreshMicrophoneChoices();
    if (!change.elsewhere && (ports.state.voiceFollowing() || state.voiceStarting)) {
      stopVoiceFollow();
      startVoiceFollow();
    }
  });
  const stopDevices = ports.microphones.onChange(refreshMicrophoneChoices);
  hearingMicrophones = function () { stopPreferences(); stopDevices(); };
}

function stopHearingMicrophones(): void {
  hearingMicrophones?.();
  hearingMicrophones = null;
}

async function openMicrophone(wanted: string): Promise<{ stream: MediaStream; fellBack: boolean }> {
  const media = navigator.mediaDevices;
  if (!wanted) return { stream: await media.getUserMedia({ audio: true }), fellBack: false };
  try {
    return { stream: await media.getUserMedia({ audio: { deviceId: { exact: wanted } } }), fellBack: false };
  } catch (err) {
    const name = err && (err as { name?: unknown }).name;
    if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    return { stream: await media.getUserMedia({ audio: true }), fellBack: true };
  }
}

function beginRecognition(): void {
  if (state.voiceTrack) (state.recognition as VoiceRecognition).start(state.voiceTrack);
  else (state.recognition as VoiceRecognition).start();
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
  syncMicrophoneSelect();
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
      if (!ports.state.voiceFollowing() && !state.voiceStarting) setVoiceStatus("", "");
    } else if (ports.desktop.canOpen()) {
      btn.disabled = false;
      setVoiceStatus("Chrome or Edge can follow your voice — this opens the saved script there.", "");
    } else {
      btn.disabled = true;
      setVoiceStatus(VOICE_DESKTOP_UNAVAILABLE, "");
    }
  } else if (ports.voice.hasRelay()) {
    btn.disabled = false;
    if (!ports.state.voiceFollowing() && !state.voiceStarting) setVoiceStatus("", "");
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
  for (let i = 0; i < state.promptWords.length; i++) {
    const el = (state.promptWords[i] as PromptWord).el;
    el.classList.toggle("spoken", i < idx);
    el.classList.toggle("current-word", i === idx);
  }
}

function clearSpokenHighlights(): void {
  state.promptWords.forEach(function (w) {
    w.el.classList.remove("spoken");
    w.el.classList.remove("current-word");
  });
}

function scrollWordIntoView(idx: number): void {
  const w = state.promptWords[idx];
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
  const combined = (state.finalTranscript + " " + state.interimTranscript).trim();
  const words = combined.split(/\s+/).map(normalizeWord).filter(Boolean);
  const recent = words.slice(-8);
  if (!recent.length || !state.speakNorms.length) return;

  const searchStart = Math.max(0, state.speakCursor - 40);
  const searchEnd = Math.min(state.speakNorms.length - 1, state.speakCursor + 80);
  const best = findBestMatch(recent, state.speakNorms, searchStart, searchEnd);

  if (best.index !== -1 && best.index !== state.speakCursor &&
      best.score >= (best.index > state.speakCursor ? 2 : 3)) {
    state.speakCursor = best.index;
    state.wordCursor = state.speakable[state.speakCursor] as number;
    applySpokenUpTo(state.wordCursor);
    scrollWordIntoView(state.wordCursor);
    if (state.promptBeatMode && state.promptBeatIndex !== -1 && state.wordCursor >= (state.beatWordEnd[state.promptBeatIndex] as number)) {
      stopVoiceFollow();
      advanceBeatAfterAutoPause();
      setVoiceStatus("Beat finished — say it again to keep following, or press Next.", "listening");
    }
  }

  if (state.finalTranscript.length > 4000) state.finalTranscript = state.finalTranscript.slice(-1200);

  if (state.speakCursor >= state.speakNorms.length - 1) {
    setVoiceStatus("Reached the end", "listening");
  } else if (ports.state.voiceFollowing()) {
    setVoiceStatus(listeningStatus("Listening"), "listening");
  }
}

function releaseVoiceStream(): void {
  if (!state.voiceStream) return;
  try { state.voiceStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  state.voiceStream = null;
  state.voiceTrack = null;
}

const DESKTOP_VOICE_WARNINGS: Record<string, () => string> = {
  "no-signal": function () {
    return "Windows isn't hearing " + (state.voiceMicName || "the microphone") +
      " — check it's plugged in, and that Settings › Privacy & security › Microphone lets desktop apps use it.";
  },
  "too-quiet": function () {
    return "Speak up a little, or move closer to " + (state.voiceMicName || "the microphone") + ".";
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
  if (searching) return;
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
  if (ports !== owner || requestedSession !== voiceSession || searching) return;
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
  if (ports.state.voiceFollowing() || state.voiceStarting) return;
  if (!state.speakNorms.length) {
    setVoiceStatus("Nothing to read yet.", "error");
    return;
  }
  state.voiceStarting = true;
  const mySession = ++voiceSession;
  setPrompterPlaying(false);
  state.finalTranscript = "";
  state.interimTranscript = "";
  const readingWord = voiceFromReadingLine ? Math.floor(readingPosition(document.getElementById("prompter-scroll") as HTMLElement)) : -1;
  const restart = state.speakable.findIndex((at) => at >= readingWord);
  state.speakCursor = readingWord < 0 ? -1 : restart < 0 ? state.speakable.length - 1 : restart;
  state.wordCursor = state.speakable[state.speakCursor] ?? -1;
  state.voiceRestarts = 0;
  state.voiceMicName = "";
  state.voiceMicFellBack = false;
  clearSpokenHighlights();

  if (!desktop && !relayed && typeof navigator.mediaDevices?.getUserMedia === "function") {
    setVoiceStatus("Asking for the microphone…", "");
    let opened: { stream: MediaStream; fellBack: boolean };
    const wanted = ports.microphones.support() === "yes" ? ports.preferences.microphone() : "";
    try {
      opened = await openMicrophone(wanted);
    } catch (err) {
      if (ports !== owner || mySession !== voiceSession) return;
      state.voiceStarting = false;
      const name = err && (err as { name?: unknown }).name;
      setVoiceStatus(
        name === "NotFoundError" || name === "DevicesNotFoundError"
          ? "No microphone was found."
          : "Microphone blocked — allow it for this site (the icon at the right of the address bar), then try again.",
        "error");
      return;
    }
    if (ports !== owner || mySession !== voiceSession) {
      try { opened.stream.getTracks().forEach(function (track) { track.stop(); }); } catch (e) {}
      return;
    }
    state.voiceStream = opened.stream;
    state.voiceMicFellBack = opened.fellBack;
    try {
      const track = state.voiceStream.getAudioTracks()[0];
      state.voiceMicName = (track && track.label) || "";
      if (wanted && !opened.fellBack && track) state.voiceTrack = track;
    } catch (e) {}
    refreshMicrophoneChoices();
  }

  try {
    state.recognition = (desktop ? ports.voice.createDesktop()
      : relayed ? ports.voice.createRelay()
      : new (ports.voice.browserRecognition() as new () => PrompterRecognition)()) as VoiceRecognition;
  } catch (e) {
    state.voiceStarting = false;
    releaseVoiceStream();
    setVoiceStatus("Could not start speech recognition.", "error");
    return;
  }
  state.recognition.continuous = true;
  state.recognition.interimResults = true;
  state.recognition.lang = "en-US";

  if (desktop || relayed) {
    setVoiceStatus(relayed ? "Starting speech recognition in the Splitpage desktop app…" : "Starting Windows speech recognition…", "");
    state.recognition.onwarning = function (e) {
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
    state.recognition.ondevice = function (e) {
      if (ports !== owner || mySession !== voiceSession) return;
      state.voiceMicName = (e && typeof e.name === "string") ? e.name : "";
    };
  }
  state.recognition.onstart = function () {
    if (ports !== owner || mySession !== voiceSession) return;
    state.voiceStarting = false;
    ports.state.setVoiceFollowing(true);
    updateVoiceButtonUI();
    setVoiceStatus(listeningStatus("Listening…"), "listening");
  };
  state.recognition.onresult = function (e) {
    if (ports !== owner || mySession !== voiceSession) return;
    let finalChunk = "", interimChunk = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i] as PrompterSpeechResult;
      if (r.isFinal) finalChunk += r[0].transcript + " ";
      else interimChunk += r[0].transcript + " ";
    }
    if (finalChunk) state.finalTranscript += finalChunk;
    state.interimTranscript = interimChunk;
    state.voiceRestarts = 0;
    onSpeechTranscript();
  };
  state.recognition.onerror = function (e) {
    if (ports !== owner || mySession !== voiceSession) return;
    state.voiceStarting = false;
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
  state.recognition.onend = function () {
    if (ports !== owner || mySession !== voiceSession) return;
    if (mySession !== voiceSession || !ports.state.voiceFollowing()) {
      if (mySession === voiceSession) releaseVoiceStream();
      updateVoiceButtonUI();
      return;
    }
    state.voiceRestarts++;
    if (state.voiceRestarts > 40) {
      ports.state.setVoiceFollowing(false);
      releaseVoiceStream();
      updateVoiceButtonUI();
      setVoiceStatus("Voice follow kept dropping out — stopped.", "error");
      return;
    }
    setTimeout(function () {
      if (ports !== owner || mySession !== voiceSession || !ports.state.voiceFollowing() || !state.recognition) return;
      const chosen = !!state.voiceTrack;
      try { beginRecognition(); }
      catch (e) {
        ports.state.setVoiceFollowing(false);
        state.recognition = null;
        releaseVoiceStream();
        updateVoiceButtonUI();
        if (chosen) setVoiceStatus(MIC_ENDED_MESSAGE, "error");
      }
    }, Math.min(2000, 150 * state.voiceRestarts));
  };
  try {
    beginRecognition();
  } catch (e) {
    state.voiceStarting = false;
    releaseVoiceStream();
    setVoiceStatus("Could not start speech recognition.", "error");
  }
}

export function stopVoiceFollow(): void {
  const wasActive = ports.state.voiceFollowing();
  voiceSession++;
  ports.state.setVoiceFollowing(false);
  state.voiceStarting = false;
  if (state.recognition) {
    try {
      state.recognition.onend = null;
      state.recognition.onresult = null;
      state.recognition.onstart = null;
      state.recognition.onerror = null;
      state.recognition.onwarning = null;
      state.recognition.ondevice = null;
      state.recognition.stop();
    } catch (e) {}
    state.recognition = null;
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
  let dismissSearch: (() => void) | null = null;
  function disposeRuntime() {
    dismissSearch?.();
    dismissSearch = null;
    disposePrompterView();
  }
  ports = nextPorts;
  prompterMirror = ports.preferences.prompterFlag("prompterMirror");

  prompterFlip = ports.preferences.prompterFlag("prompterFlip");

  state.promptBeatMode = ports.preferences.prompterFlag("prompterSceneMode");

  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__prompterTest", (): PrompterTestHooks => ({
    checkSceneBoundaryNow: function () {
      const scroller = document.getElementById("prompter-scroll") as HTMLElement;
      if (!state.promptBeatMode || state.promptBeatEndWordOffset == null) return false;
      if (!beatPastReadingLine(scroller.scrollTop, state.promptBeatEndWordOffset, state.promptBeatGuideOffset)) return false;
      setPrompterPlaying(false);
      advanceBeatAfterAutoPause();
      return true;
    },
    simulateVoiceWordCursor: function (idx) {
      state.wordCursor = idx;
      if (!state.promptBeatMode || state.promptBeatIndex === -1 || state.wordCursor < (state.beatWordEnd[state.promptBeatIndex] as number)) return false;
      stopVoiceFollow();
      advanceBeatAfterAutoPause();
      return true;
    },
    launchFromScript: launchPrompterFromScript,
    updateStatus: updatePrompterStatus
  }), (withdraw) => { withdrawHook = withdraw; });

  const launch = readPrompterLaunch();
  if (launch) startPrompterLaunch(launch);

  return {
    chooseMicrophone: function (id) {
      ports.preferences.setMicrophone(id);
      document.getElementById("pp-play")?.focus({ preventScroll: true });
    },
    closeFind: function () {
      if (!searching || !dismissSearch) return false;
      dismissSearch();
      return true;
    },
    setSearching: function (value, dismiss) {
      searching = value;
      dismissSearch = value ? dismiss ?? null : null;
      if (value) { setPrompterPlaying(false); stopVoiceFollow(); }
    },
    jumpToFind: function (range) {
      if (!searching || !ports.state.isOpen()) return;
      const content = document.getElementById("prompter-content") as HTMLElement;
      if (!content.contains(range.startContainer)) return;
      const scroller = document.getElementById("prompter-scroll") as HTMLElement;
      const node = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
      const word = node?.closest<HTMLElement>(".w");
      const rect = range.getClientRects()[0];
      const viewport = scroller.getBoundingClientRect();
      const top = word ? word.offsetTop : rect ? scroller.scrollTop + (prompterFlip ? viewport.bottom - rect.bottom : rect.top - viewport.top) : 0;
      scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 2);
      let index = state.promptWords.findIndex((entry) => entry.el === word);
      if (index < 0) index = state.promptWords.findIndex((entry) => range.comparePoint(entry.el, 0) >= 0);
      if (index < 0) index = state.promptWords.length - 1;
      voiceFromReadingLine = true;
      clearSpokenHighlights();
      if (state.promptBeatMode) {
        const beat = index < 0 ? -1 : state.beatWordEnd.findIndex((end) => end > index);
        state.promptBeatIndex = beat;
        state.promptBeatGuideOffset = scroller.clientHeight / 2;
        state.promptBeatEndWordOffset = beat < 0 ? null : Math.max(top + state.promptLinePx, (state.promptWords[(state.beatWordEnd[beat] as number) - 1] as PromptWord).el.offsetTop);
        updateBeatReadout();
      }
      updatePrompterStatus();
    },
    onViewChange: function (listener) {
      viewListeners.add(listener);
      return () => { viewListeners.delete(listener); };
    },
    openPrompter, closePrompter, stopVoiceFollow, startVoiceFollow,
    setPrompterPlaying, setPrompterSpeed, applyPrompterSize, stepPrompterSpeed, stepPrompterSize,
    updatePrompterStatus, buildPrompterContent, updateVoiceAvailability,
    cueBeatForCurrentPosition, updateBeatReadout, setPrompterMirror, setPrompterFlip,
    setPrompterBeatMode, stepBeat, acquireWakeLock, wireTagEntityContainer,
    disposeRuntime,
    voiceActive: function () { return ports.state.voiceFollowing(); },
    playing: function () { return ports.state.isPlaying(); },
    isOpen: function () { return ports.state.isOpen(); },
    skipShot: function () { return ports.state.skipsShot(); },
    setSkipShot: function (value) { ports.state.setSkipShot(value); },
    mirror: function () { return prompterMirror; },
    flip: function () { return prompterFlip; },
    beatMode: function () { return !!state.promptBeatMode; },
    dispose: function () {
      if (ports !== nextPorts) return;
      stopHearingMicrophones();
      disposeRuntime();
      clearTimeout(initialReadyTimer as TimerHandle);
      initialReadyTimer = null;
      withdrawHook?.();
      dismissSearch = null;
      viewListeners.clear();
      (ports as unknown) = null;
    }
  };
}
