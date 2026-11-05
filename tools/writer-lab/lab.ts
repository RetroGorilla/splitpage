import { randomIds } from "../../src/adapters/identity/ids.ts";
import { createRichText } from "../../src/adapters/richtext/richtext.ts";
import { createDocumentSession } from "../../src/application/session/document-session.ts";
import type { Command } from "../../src/application/session/document-session.ts";
import { cellRuns, cellTextCommand } from "../../src/application/commands/cell-text.ts";
import { createUndo } from "../../src/application/editing/undo/undo.ts";
import type { Step } from "../../src/core/text/steps.ts";
import { createImageIngestion } from "../../src/core/document/media.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { gallerySize } from "../../src/core/document/gallery.ts";
import { STATE_FIELDS } from "../../src/core/merge/state-fields.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import type { MigratePorts } from "../../src/core/migrate.ts";
import { createProductionReaders } from "../../src/core/production/readers.ts";
import { syncCommentAnchors } from "../../src/core/text/anchors.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { projection } from "../../src/core/text/runs.ts";
import type { Run } from "../../src/core/text/runs.ts";
import { findInFlow, flowOf, isCollapsed, replaceAll, replaceMatch, withinOneBeat } from "../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowRange, FlowRow } from "../../src/core/flow/flow.ts";
import { caretAfterStep } from "../../src/features/undo/caret.ts";
import { LONG_DEMO } from "../../src/starters/index.ts";
import { flowCommand as sharedFlowCommand } from "../../src/application/commands/flow.ts";
import { createSurface } from "../../src/features/writer/flow-surface.ts";
import { createEditorSelection } from "../../src/application/editing/selection.ts";
import type { Surface, SurfaceSettings } from "../../src/features/writer/flow-surface.ts";

interface LabSettings extends SurfaceSettings {
  tickStyle: string;
  visualOnly: string;
  opening: string;
  tint: boolean;
  note: boolean;
  script: string;
  size: number;
}

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const saved = readSaved();

function readSaved(): Partial<LabSettings> {
  try { return JSON.parse(localStorage.getItem("writer-lab") || "{}") as Partial<LabSettings>; } catch { return {}; }
}

const settings: LabSettings = {
  enter: "double", tick: "delete", gapTyping: "here", markdown: true, tickStyle: "number", visualOnly: "chip", opening: "sentence",
  tint: true, note: true, script: "demo", size: 19, ...saved
};

const newId = (): string => randomIds.id("r");

const images = createImageIngestion(() => null);
const richText = createRichText({ DOMParser, images, ids: randomIds });
const cache = new Map<string, Run[]>();
function decode(html: string | null | undefined): Run[] {
  const text = html ?? "";
  const hit = cache.get(text);
  if (hit) return hit;
  // why: the screen-position code counts pictures and video cards, so the decoder has to keep them too
  const made = richText.decode(text, { media: true });
  if (cache.size > 20000) cache.clear();
  cache.set(text, made);
  return made;
}
const cellOf = richText.createCellReader(deepFreeze as unknown as Parameters<typeof richText.createCellReader>[0]);
const mediaRuns = (html: unknown): Run[] => richText.decode(html == null ? "" : html, { media: true });

function plainVisual(row: FlowRow): string {
  const text = projection(decode(row.visualText)).replace(/\s+/g, " ").trim();
  if (text) return text.length > 70 ? text.slice(0, 69) + "…" : text;
  return gallerySize(row) ? "Picture" : "";
}

const flowPorts: FlowPorts = {
  cells: html => decode(html),
  newId,
  hasVisual: row => !!projection(decode(row.visualText)) || !!gallerySize(row)
};

const migratePorts: MigratePorts = {
  images,
  sanitize: html => richText.sanitize(html),
  htmlIds: html => Array.from(richText.inertBody(html).getElementsByTagName("*")).flatMap(el => [el.getAttribute("data-cmt") || "", el.getAttribute("data-broll-id") || ""]),
  decode: (html, opts) => richText.decode(html, opts),
  videoCardHtml: href => richText.videoCardHtml(href),
  readers: createProductionReaders(cellOf, deepFreeze as unknown as Parameters<typeof createProductionReaders>[1]),
  ids: randomIds,
  fields: STATE_FIELDS
};

const stamps = { clock: { nowIso: () => new Date().toISOString(), now: () => Date.now() }, editor: { name: () => "Adam" } };
const textPorts = { ...stamps, cells: cellOf };

const undo = createUndo({
  held: () => session.held(),
  runs: html => mediaRuns(html),
  now: () => Date.now(),
  cleared: () => undefined
});

const session = createDocumentSession({
  entry: raw => migrateRows(raw, migratePorts),
  undo: {
    adopt: doc => undo.adopt(doc as unknown as Parameters<typeof undo.adopt>[0]),
    record: () => undo.noteEdit(),
    absorbDisk: doc => undo.noteRemote(doc as unknown as Parameters<typeof undo.noteRemote>[0]),
    absorbReload: () => undo.absorbRemote()
  },
  effects: { dirty: () => undefined, draft: () => undefined, save: () => undefined, refresh: () => undefined },
  capability: { edit: () => ({ allowed: true }) },
  reconcile: { anchors: doc => syncCommentAnchors(doc, cellOf), records: () => null },
  attribution: { attribute: () => null },
  report: error => { console.error(error); notice("Something went wrong: " + String(error)); },
  timers: { now: () => Date.now(), start: (run, ms) => window.setTimeout(run, ms), stop: handle => window.clearTimeout(handle as number) }
});
undo.routeReplays(task => session.replay(task), stamps);

const selections = new Map<number, { before: FlowRange | null; after: FlowRange }>();

function currentDoc(): FlowDoc {
  return session.read(doc => doc as unknown as FlowDoc);
}

let noticeTimer = 0;

function notice(text: string): void {
  const el = $("notice");
  el.textContent = text;
  el.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { el.hidden = true; }, 4200);
}

function runOrThrow(command: Command): void {
  const outcome = session.run(command);
  if (outcome.kind === "failed") throw outcome.error;
  if (outcome.kind === "rejected") notice(outcome.reason);
}

function commit(name: string, operation: (doc: FlowDoc) => FlowOutcome, before: FlowRange | null): FlowOutcome {
  let edit: FlowOutcome = null;
  runOrThrow(sharedFlowCommand(name, doc => { edit = operation(doc); return edit; }, stamps, before));
  undo.flush();
  const top = undo.last();
  const result = edit as FlowOutcome;
  if (top && result && "selection" in result) selections.set(top.n, { before, after: result.selection });
  return result;
}

function syncBeat(rowId: string, runs: readonly Run[]): void {
  runOrThrow(cellTextCommand(rowId, "audioText", cellRuns(runs), textPorts));
}

function replayUndo(dir: "undo" | "redo"): void {
  const entry = dir === "undo" ? undo.last() : undo.nextRedo();
  const recorded = entry ? selections.get(entry.n) : undefined;
  const result = dir === "undo" ? undo.undo() : undo.redo();
  undo.settleAfterApply();
  if (!result.ok) return;
  surface.paint();
  const steps = (result as { steps?: readonly Step[] }).steps ?? [];
  const target = recorded ? (dir === "undo" ? recorded.before ?? recorded.after : recorded.after) : null;
  if (target) {
    surface.place(target, true);
  } else {
    const step = steps.find(item => item.op === "rowField" && (item as { key?: string }).key === "audioText") as { rowId: string } | undefined;
    if (step) {
      const offset = caretAfterStep(mediaRuns as unknown as Parameters<typeof caretAfterStep>[0], step as unknown as Parameters<typeof caretAfterStep>[1]);
      surface.place({ anchor: { kind: "beat", rowId: step.rowId, offset }, head: { kind: "beat", rowId: step.rowId, offset } }, true);
    }
  }
  changed();
}

let debugTimer = 0;
let quiet = false;
function changed(): void {
  if (quiet) return;
  window.clearTimeout(debugTimer);
  debugTimer = window.setTimeout(function () {
    updateStats();
    drawBeats();
  }, 350);
}

function updateStats(): void {
  const doc = currentDoc();
  let words = 0;
  doc.rows.forEach(row => { words += (projection(decode(row.audioText)).match(/\S+/g) || []).length; });
  $("stat-words").textContent = words.toLocaleString() + " words";
  $("stat-beats").textContent = doc.rows.length + " beats";
  $("stat-paras").textContent = flowOf(doc).filter(block => block.kind === "paragraph").length + " paragraphs";
  const check = $("stat-check");
  // why: this check re-reads every beat, which on a long script would itself make typing feel slow
  if (doc.rows.length > 300) {
    check.textContent = "";
    check.classList.remove("bad");
    return;
  }
  const problems = surface.domCheck();
  check.textContent = problems.length ? "Out of sync: " + problems[0] : "Screen matches the script";
  check.classList.toggle("bad", problems.length > 0);
}

function drawBeats(): void {
  const panel = $("beats");
  if (panel.hidden) return;
  const doc = currentDoc();
  const parts: string[] = [];
  flowOf(doc).forEach(function (block) {
    if (block.kind === "heading") {
      parts.push('<div class="b-head">' + esc(block.scene.name) + "</div>");
      return;
    }
    parts.push('<div class="b-par">');
    block.beats.forEach(function (row) {
      const text = projection(decode(row.audioText));
      const visual = plainVisual(row);
      parts.push('<div class="b-beat" data-for="' + esc(row.id) + '"><span class="b-text">' + esc(text.slice(0, 60) || "(no narration)") + "</span>" +
        (visual ? '<span class="b-visual">▣ ' + esc(visual) + "</span>" : "") +
        (row.status === "shot" ? '<span class="b-filmed">Filmed</span>' : "") + "</div>");
    });
    parts.push("</div>");
  });
  panel.innerHTML = parts.join("");
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function selectionMoved(range: FlowRange | null): void {
  const doc = currentDoc();
  const crossing = !!range && !isCollapsed(range) && !withinOneBeat(range);
  document.querySelectorAll<HTMLButtonElement>("[data-one-beat]").forEach(function (button) {
    button.disabled = crossing;
    button.title = crossing ? "Select text within one beat to use this" : button.getAttribute("data-title") || "";
  });
  const words = range && !isCollapsed(range) ? (window.getSelection()?.toString().match(/\S+/g) || []).length : 0;
  $("stat-selection").textContent = words ? words + " selected" : "";
  updateMarks(range);
  const note = $("note");
  const head = range?.head;
  if (!settings.note || !head || head.kind !== "beat") { note.hidden = true; return; }
  const row = doc.rows.find(item => item.id === head.rowId);
  const visual = row ? plainVisual(row) : "";
  const el = row ? document.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(row.id) + '"]') : null;
  if (!row || !el || !visual || el.classList.contains("is-visual-only")) { note.hidden = true; return; }
  note.textContent = "▣ " + visual;
  note.hidden = false;
  const sel = window.getSelection();
  const box = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
  const host = $("scroll").getBoundingClientRect();
  const top = box && box.height ? box.top : el.getBoundingClientRect().top;
  note.style.top = top - host.top + $("scroll").scrollTop + "px";
}

function updateMarks(range: FlowRange | null): void {
  const pending = surface.pendingMarks() as Record<string, unknown> | null;
  const el = range && range.head.kind === "beat" ? document.querySelector('.wr-beat[data-id="' + CSS.escape(range.head.rowId) + '"]') : null;
  const sel = window.getSelection();
  const node = sel?.focusNode ?? null;
  const at = node && node.nodeType === 3 ? node.parentElement : node as Element | null;
  const within = (tag: string) => !!(at && el && el.contains(at) && at.closest(tag));
  const state: Record<string, boolean> = pending
    ? { b: !!pending["b"], i: !!pending["i"], u: !!pending["u"], s: !!pending["s"], hl: !!pending["hl"] }
    : { b: within("strong"), i: within("em"), u: within("u"), s: within("s"), hl: within("mark") };
  document.querySelectorAll<HTMLElement>("[data-mark]").forEach(button => button.classList.toggle("on", !!state[button.getAttribute("data-mark") as string]));
}

function repeatScript(raw: Record<string, unknown>, times: number): Record<string, unknown> {
  const rows = raw["rows"] as Record<string, unknown>[];
  const out: Record<string, unknown>[] = [];
  for (let t = 0; t < times; t++) rows.forEach(row => out.push({ ...row, id: row["id"] + "-" + t, audioText: stripComments(row["audioText"]) }));
  return { ...raw, rows: out, comments: [], docId: "d" + "2".repeat(32) };
}

function stripComments(html: unknown): string {
  return String(html ?? "").replace(/<span class="cmt-anchor"[^>]*>|<\/span>(?=<!--cmt-->)/g, "");
}

function withSentenceBreaks(raw: Record<string, unknown>): Record<string, unknown> {
  const rows = raw["rows"] as Record<string, unknown>[];
  let endedSentence = true;
  const next = rows.map(function (row) {
    const text = projection(decode(String(row["audioText"] ?? "")));
    const flagged = endedSentence ? { ...row, paragraphStart: true } : row;
    if (text) endedSentence = /[.!?…]["')\]]*\s*$/.test(text);
    return flagged;
  });
  return { ...raw, rows: next };
}

function demoScript(): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(LONG_DEMO.state)) as Record<string, unknown>;
  const rows = base["rows"] as Record<string, unknown>[];
  const scenes = [
    { id: "scene-open", name: "The flea market find", firstSceneId: rows[0]?.["id"] },
    { id: "scene-teardown", name: "Taking it apart", firstSceneId: rows[6]?.["id"] },
    { id: "scene-repair", name: "The repair", firstSceneId: rows[15]?.["id"] }
  ];
  const withVisualOnly = rows.map((row, index) => index === 3 ? { ...row, audioText: "" } : row);
  return { ...base, rows: withVisualOnly, sections: scenes };
}

function loadScript(): void {
  let raw: Record<string, unknown>;
  if (settings.script === "long") raw = repeatScript(demoScript(), 30);
  else if (settings.script === "blank") raw = { title: "Blank", docId: "d" + "3".repeat(32), rows: [{ id: "first", audioText: "", visualText: "", status: "todo" }], comments: [] };
  else raw = demoScript();
  if (settings.opening === "sentence") raw = withSentenceBreaks(raw);
  loadDocument(raw);
  drawBeats();
}

function loadDocument(raw: unknown): void {
  surface.dispose();
  session.adopt(raw);
  selections.clear();
  $("doc").innerHTML = "";
  surface = makeSurface();
  surface.paint();
  updateStats();
}

function applySettings(): void {
  const body = document.body;
  body.setAttribute("data-tick", settings.tickStyle);
  body.setAttribute("data-visual-only", settings.visualOnly);
  body.classList.toggle("tint", settings.tint);
  body.style.setProperty("--wr-font", settings.size + "px");
  localStorage.setItem("writer-lab", JSON.stringify(settings));
}

function bindSwitches(): void {
  document.querySelectorAll<HTMLSelectElement | HTMLInputElement>("[data-setting]").forEach(function (control) {
    const name = control.getAttribute("data-setting") as keyof LabSettings;
    const current = settings[name];
    if (control instanceof HTMLInputElement && control.type === "checkbox") control.checked = !!current;
    else control.value = String(current);
    control.addEventListener("change", function () {
      const value = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control instanceof HTMLInputElement && control.type === "range" ? Number(control.value) : control.value;
      (settings as unknown as Record<string, unknown>)[name] = value;
      applySettings();
      if (name === "script" || name === "opening") loadScript();
      $("doc").focus();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-mark]").forEach(function (button) {
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => surface.format(button.getAttribute("data-mark") as Parameters<Surface["format"]>[0]));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-one-beat]").forEach(function (button) {
    button.setAttribute("data-title", button.title);
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", () => notice("This test page doesn't include " + button.title.toLowerCase() + " yet."));
  });
  $("toggle-beats").addEventListener("click", function () {
    const panel = $("beats");
    panel.hidden = !panel.hidden;
    drawBeats();
  });
  $("toggle-switches").addEventListener("click", function () {
    const panel = $("switches");
    panel.hidden = !panel.hidden;
  });
  $("reset").addEventListener("click", loadScript);
}

function bindFind(): void {
  const bar = $("find");
  const input = $("find-text") as HTMLInputElement;
  const replacement = $("find-replace") as HTMLInputElement;
  const count = $("find-count");
  let at = -1;
  function matches() { return findInFlow(currentDoc(), input.value, false, flowPorts); }
  // why: the cursor stays in the Find box, so matches are painted as highlights rather than selected
  function paintMatches(found: readonly { range: FlowRange }[]): void {
    const all: Range[] = [];
    let current: Range | null = null;
    found.slice(0, 2000).forEach(function (match, index) {
      const made = surface.domRange(match.range);
      if (!made) return;
      if (index === at) current = made; else all.push(made);
    });
    CSS.highlights.set("wr-find", new Highlight(...all));
    if (current) {
      CSS.highlights.set("wr-find-current", new Highlight(current));
      (current as Range).startContainer.parentElement?.scrollIntoView({ block: "nearest" });
    } else {
      CSS.highlights.delete("wr-find-current");
    }
  }
  function show(step: number, keep: HTMLElement = input): void {
    const found = matches();
    if (!found.length) {
      count.textContent = input.value ? "No matches" : "";
      at = -1;
      paintMatches([]);
      return;
    }
    at = (at + step + found.length) % found.length;
    paintMatches(found);
    count.textContent = at + 1 + " of " + found.length;
    keep.focus();
  }
  function close(): void {
    const found = matches()[at];
    bar.hidden = true;
    CSS.highlights.delete("wr-find");
    CSS.highlights.delete("wr-find-current");
    $("doc").focus();
    if (found) surface.place(found.range, true);
  }
  (window as unknown as { __openFind: () => void }).__openFind = function () {
    bar.hidden = false;
    input.focus();
    input.select();
    at = -1;
    show(1);
  };
  input.addEventListener("input", () => { at = -1; show(1); });
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); show(event.shiftKey ? -1 : 1); }
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  replacement.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  $("find-next").addEventListener("click", () => show(1));
  $("find-close").addEventListener("click", close);
  $("find-one").addEventListener("click", function () {
    const found = matches()[at];
    if (!found) { show(1); return; }
    undo.breakCoalescing();
    surface.apply("replace", doc => replaceMatch(doc, found.range, replacement.value, flowPorts), found.range);
    at -= 1;
    show(1, replacement);
  });
  $("find-all").addEventListener("click", function () {
    undo.breakCoalescing();
    surface.apply("replace-all", doc => replaceAll(doc, input.value, replacement.value, false, flowPorts), null);
    at = -1;
    show(1, replacement);
  });
}

function bindVisualBox(): void {
  const box = $("visual-box");
  const area = $("visual-text") as HTMLTextAreaElement;
  let rowId: string | null = null;
  let pendingOwn = false;
  let opened: FlowRange | null = null;
  function open(): void {
    const range = surface.selection();
    if (!range || range.head.kind !== "beat") { notice("Put the caret in a beat first."); return; }
    if (!isCollapsed(range) && !withinOneBeat(range)) { notice("Select text within one beat to give it a visual."); return; }
    pendingOwn = !isCollapsed(range);
    opened = range;
    rowId = range.head.rowId;
    const row = currentDoc().rows.find(item => item.id === rowId);
    area.value = pendingOwn ? "" : row ? projection(decode(row.visualText)) : "";
    box.hidden = false;
    const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    if (rect) {
      box.style.left = Math.max(20, Math.min(rect.left, window.innerWidth - 400)) + "px";
      box.style.top = Math.min(rect.bottom + 8, window.innerHeight - 180) + "px";
    }
    area.focus();
  }
  $("open-visual").addEventListener("mousedown", event => event.preventDefault());
  $("open-visual").addEventListener("click", open);
  $("note").addEventListener("mousedown", event => event.preventDefault());
  $("note").addEventListener("click", open);
  area.addEventListener("input", function () {
    if (pendingOwn && opened) {
      const held = area.value;
      const made = surface.toOwnBeat(opened);
      pendingOwn = false;
      if (made) {
        rowId = made;
        const row = currentDoc().rows.find(item => item.id === made);
        const end = row ? projection(decode(row.audioText)).length : 0;
        opened = { anchor: { kind: "beat", rowId: made, offset: 0 }, head: { kind: "beat", rowId: made, offset: end } };
      }
      area.value = held;
      area.focus();
    }
    const id = rowId;
    if (!id) return;
    const doc = currentDoc();
    const rows = doc.rows.map(row => row.id === id ? { ...row, visualText: toHtml(area.value ? [{ text: area.value, marks: {} }] : []) } : row);
    runOrThrow(sharedFlowCommand("set-visual", () => ({ rows, sections: doc.sections as FlowEdit["sections"], removedComments: [], selection: { anchor: { kind: "beat", rowId: id, offset: 0 }, head: { kind: "beat", rowId: id, offset: 0 } } }), stamps));
    surface.paint();
    changed();
  });
  function close(): void {
    box.hidden = true;
    undo.breakCoalescing();
    rowId = null;
    $("doc").focus();
    if (opened) surface.place(opened);
    opened = null;
  }
  area.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  $("visual-done").addEventListener("click", close);
}

function makeSurface(): Surface {
  return createSurface({
    root: $("doc"),
    lifetime: session,
    heldSelection: createEditorSelection({ epoch: () => session.epoch(), order: () => [], keys: () => null }),
    doc: currentDoc,
    flow: flowPorts,
    decode: html => decode(html).slice(),
    storedHtml: html => richText.storedHtmlFromDom(html) as string,
    syncBeat,
    commit,
    undo: replayUndo,
    breakCoalescing: () => undo.breakCoalescing(),
    notice,
    changed,
    selectionMoved,
    settings: () => settings,
    openFind: () => (window as unknown as { __openFind: () => void }).__openFind(),
    plainVisual
  });
}

let surface: Surface = makeSurface();

bindSwitches();
bindFind();
bindVisualBox();
applySettings();
loadScript();

(window as unknown as Record<string, unknown>)["__lab"] = {
  get surface() { return surface; },
  session,
  undo,
  settings,
  doc: currentDoc,
  text: (id: string) => {
    const row = currentDoc().rows.find(item => item.id === id);
    return row ? projection(decode(row.audioText)) : null;
  },
  rows: () => currentDoc().rows.map(row => ({ id: row.id, text: projection(decode(row.audioText)), start: !!row.paragraphStart, visual: plainVisual(row), html: row.audioText })),
  sections: () => (currentDoc().sections ?? []) as unknown[],
  comments: () => currentDoc().comments.map(comment => comment.id),
  load: loadDocument,
  setting: (name: string, value: unknown) => { (settings as unknown as Record<string, unknown>)[name] = value; applySettings(); },
  check: () => surface.domCheck(),
  flush: () => undo.flush(),
  sizes: () => undo.sizes(),
  find: (needle: string) => findInFlow(currentDoc(), needle, false, flowPorts),
  quiet: (on: boolean) => { quiet = on; },
  reloadDemo: () => { settings.script = "demo"; loadScript(); },
  replaceMatch: (range: FlowRange, text: string) => replaceMatch(currentDoc(), range, text, flowPorts),
  longScript: (times: number) => {
    const raw = repeatScript(demoScript(), times);
    delete raw["sections"];
    return raw;
  }
};
