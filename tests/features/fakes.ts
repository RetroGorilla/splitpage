import { swapBeatsCommand } from "../../src/application/commands/rows.ts";
import { createNumberingReader } from "../../src/application/session/numbering.ts";
import type { OnboardingPorts } from "../../src/features/onboarding/ports.ts";
import type { DocumentPlace } from "../../src/application/location/document-place.ts";
import type { ActionRegistry, ActionSource } from "../../src/application/actions.ts";
import type { PreferenceChanges, PreferenceNotice, Preferences } from "../../src/application/preferences/preferences.ts";
import type { SaveChange, SaveState } from "../../src/application/save/save-state.ts";
import type { Blocker, ScreenState } from "../../src/application/screen.ts";
import type { DocumentDestination } from "../../src/application/transitions/ports.ts";
import type { Arrived, Incoming, Transitions } from "../../src/application/transitions/transitions.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import type { PictureStore } from "../../src/application/media/picture-store.ts";
import type { Operations } from "../../src/application/session/operation.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";
import type { ImageRef } from "../../src/core/document/ports.ts";
import type { DocumentReader } from "../../src/application/session/document-reader.ts";
import type { ViewFlags } from "../../src/application/preferences/view-flags.ts";
import type { SidePanels } from "../../src/application/side-panels.ts";
import type { Command, CommandOutcome, DocumentView, SessionListener } from "../../src/application/session/document-session.ts";
import type { UndoControl } from "../../src/application/editing/undo-control.ts";
import type { NoticeKind, NoticePort } from "../../src/application/effects/ports.ts";
import type { DocumentEdits } from "../../src/application/session/document-edits.ts";
import type { TextServices } from "../../src/application/text/services.ts";
import type { PrompterFeaturePorts } from "../../src/features/prompter/ports.ts";
import type { FindPorts } from "../../src/features/find/ports.ts";
import type { WriterFindAccess } from "../../src/features/common/writer-find.ts";
import type { WriterFeaturePorts } from "../../src/features/writer/ports.ts";
import { createFlowWriter } from "../../src/features/writer/flow-writer.ts";
import { createPaintGuard } from "../../src/application/editing/paint-guard.ts";
import { createEditorSelection } from "../../src/application/editing/selection.ts";
import type { PrintDialogPort } from "../../src/application/export/print-dialog.ts";
import type { PdfPrinter } from "../../src/application/export/pdf-printer.ts";
import type { ExportDocument } from "../../src/core/document/export-document.ts";

export function fakePrintDialog() {
  const pages: string[] = [];
  let closed = 0;
  const printDialog: PrintDialogPort = { reserve: () => ({
    ended: new Promise(() => {}),
    print: async (html) => { pages.push(html); return "opened"; },
    close: () => { closed++; }
  }) };
  return { printDialog, pages, closed: () => closed };
}

export function fakeTagCategories() {
  const selected: (string | null)[] = [];
  return { selected, renderCategories: (category: string | null) => { selected.push(category); } };
}

export function fakePdfPrinter() {
  const pages: { html: string; doc: ExportDocument }[] = [];
  const pdf = new Uint8Array([37, 80, 68, 70]);
  const pdfPrinter: PdfPrinter = { print: async (html, doc) => { pages.push({ html, doc }); return pdf; } };
  return { pdfPrinter, pages, pdf };
}

export function fakeWriterPorts(initial: DocumentView) {
  const reader = fakeDocument(initial);
  const notices = fakeNotices();
  const editing = fakeEdits();
  const selection = createEditorSelection<Element, Range, Element>({ epoch: () => 0, order: () => [], keys: () => [] });
  const paint = createPaintGuard();
  const calls: unknown[][] = [];
  const state = { open: false, allowed: true, size: null as number | null, lifetime: 1, serial: 0 };
  const ports: WriterFeaturePorts = {
    flow: { prepareSplit: () => {}, splitReady: () => true, create: (root, selectionMoved, step) => createFlowWriter({
      root, selectionMoved, doc: () => initial, lifetime: { epoch: () => 0 }, heldSelection: selection,
      flow: { cells: html => [{ text: String(html ?? ""), marks: {} }], newId: () => "new", hasVisual: row => !!row.visualText },
      decode: html => [{ text: html, marks: {} }], storedHtml: html => html, run: editing.edits.run, moveBeat: swapBeatsCommand,
      shown: edit => edit(), editingBlocked: () => false, text: { ...editing.edits.stamps, cells: () => [] },
      undo: { step, flush: () => {}, breakCoalescing: () => {}, last: () => null, nextRedo: () => null },
      caretAfterStep: () => 0, notice: () => {}, changed: () => {}, plainVisual: () => "",
      beatInput: () => {}, typeAtBeatEdge: () => false, beatKeydown: () => false, beatSelection: () => {},
      leaveBeat: () => {}, newCommentId: () => "c", openComment: () => {}
    }) },
    document: reader.document,
    edits: { allowed: () => state.allowed, run: editing.edits.run, text: { ...editing.edits.stamps, cells: () => [] } },
    text: {
      ...fakeTextServices(document).text,
      htmlToPlainText: (html) => String(html ?? ""),
      productionReaders: { cellOf: () => [], tagsInField: () => [], cueNamesInField: () => [], brollInField: () => [], brollPropsInField: () => [], wordCount: () => 0 }
    },
    editing: {
      selection: () => selection, paint: () => paint
    },
    undo: { breakCoalescing: () => {}, last: () => null, nextRedo: () => null, mark: () => 0, lifetime: () => state.lifetime, serial: () => state.serial },
    panels: () => ({ closeAll: () => { calls.push(["closeAll"]); }, open: (id) => { calls.push(["openPanel", id]); } }),
    preferences: () => ({ writerSize: () => state.size, setWriterSize: (size) => { state.size = size; } }),
    view: () => ({ writerOpen: () => state.open, findOpen: () => false, setWriterOpen: (open) => { state.open = open; calls.push(["setOpen", open]); } }),
    notices: notices.notices,
    actions: { invoke: (id) => ({ kind: "unknown", id }) },
    formatting: { selection: () => {}, confirmLink: () => {}, cancelLink: () => {} },
    dismissTagGhost: () => { calls.push(["hideGhost"]); },
    scheduleStats: (job) => { calls.push(["schedule", job]); },
    cancelStats: () => { calls.push(["cancelStats"]); }
  };
  return { ports, reader, notices, calls, state };
}

export function fakeFindPresent() {
  const state = { open: false, searching: false };
  const jumps: Range[] = [];
  const listeners = new Set<() => void>();
  const present: FindPorts["present"] = {
    isOpen: () => state.open,
    setSearching: (value) => { state.searching = value; },
    jump: (range) => { jumps.push(range); },
    onViewChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  return { present, state, jumps, changed: () => { for (const listener of listeners) listener(); } };
}

export function fakeFindWriter(initial: WriterFindAccess | null = null) {
  let current = initial;
  const writer: NonNullable<FindPorts["writer"]> = () => current;
  return { writer, set: (value: WriterFindAccess | null) => { current = value; } };
}

export function fakePrompterPorts(initial: DocumentView | null = null) {
  const reader = fakeDocument(initial);
  const notices = fakeNotices();
  const calls: unknown[][] = [];
  const state = { open: false, playing: false, skipShot: false, voice: false };
  const flags = { prompterMirror: false, prompterFlip: false, prompterSceneMode: false };
  const cellOf: TextServices["cellOf"] = (html) => [{ text: String(html ?? ""), marks: {} }];
  const ports: PrompterFeaturePorts = {
    document: reader.document,
    text: { cellOf, productionReaders: {
      wordCount: (html) => String(html ?? "").trim().split(/\s+/).filter(Boolean).length
    } },
    opening: { open: async (opening) => { calls.push(["open", opening]); } },
    startup: { ready: () => null },
    desktop: { running: () => false, canOpen: () => false, open: async () => null },
    voice: {
      available: () => false, known: () => true, load: async () => null,
      createDesktop: () => ({ start() {}, stop() {} }), createRelay: () => ({ start() {}, stop() {} }),
      hasRelay: () => false, setRelay: (value) => { calls.push(["relay", value]); return false; },
      browserRecognition: () => null
    },
    panels: { close: (id) => { calls.push(["close", id]); }, closeAll: () => { calls.push(["closeAll"]); } },
    preferences: {
      prompterFlag: (name) => flags[name],
      setPrompterFlag: (name, value) => { flags[name] = value; calls.push([name, value]); },
      skipOnboardingForPrompter: () => { calls.push(["skipOnboarding"]); }
    },
    viewFlags: { hideShot: () => false }, notices: notices.notices, focus: { lastRow: () => null },
    state: {
      isOpen: () => state.open, isPlaying: () => state.playing, skipsShot: () => state.skipShot,
      voiceFollowing: () => state.voice, setOpen: (value) => { state.open = value; calls.push(["setOpen", value]); },
      setPlaying: (value) => { state.playing = value; calls.push(["setPlaying", value]); },
      setSkipShot: (value) => { state.skipShot = value; }, setVoiceFollowing: (value) => { state.voice = value; }
    },
    files: { parse: async (file) => { calls.push(["parse", file]); return { state: initial, kind: "splitpage", docIdEmbedded: true }; } },
    installTagEntityContainer: (id, rootClick) => { calls.push(["installTagEntityContainer", id, rootClick]); return () => { calls.push(["removeTagEntityContainer", id]); }; }
  };
  return { ports, reader, notices, calls, state, flags };
}

export function fakeTextServices(document: Document) {
  const calls: { method: string; html: unknown }[] = [];
  const inertBody = (html: unknown): HTMLElement => {
    const body = document.createElement("div");
    body.innerHTML = String(html ?? "");
    return body;
  };
  const text: Pick<TextServices<HTMLElement>, "fromHtml" | "inertBody" | "cleanPastedCell" | "sanitizeHtml" | "storedHtmlFromDom"> = {
    cleanPastedCell: (cell) => {
      calls.push({ method: "cleanPastedCell", html: cell });
      return cell.map((run) => ({ ...run }));
    },
    fromHtml: (html) => {
      calls.push({ method: "fromHtml", html });
      return [{ text: inertBody(html).textContent ?? "", marks: {} }];
    },
    inertBody: (html) => {
      calls.push({ method: "inertBody", html });
      return inertBody(html);
    },
    sanitizeHtml: (html) => {
      calls.push({ method: "sanitizeHtml", html });
      return String(html ?? "");
    },
    storedHtmlFromDom: (html) => {
      calls.push({ method: "storedHtmlFromDom", html });
      return html;
    }
  };
  return { text, calls };
}

export function fakeNotices() {
  const shown: { message: string; kind: NoticeKind | undefined; label?: string; action?: () => void; sticky: boolean | undefined; notice: ReturnType<typeof notice> }[] = [];
  function notice() {
    let connected = true;
    const clicks = new Set<() => void>();
    return {
      get isConnected() { return connected; },
      dismiss: () => { connected = false; },
      addEventListener: (_type: "click", listener: () => void) => { clicks.add(listener); },
      removeEventListener: (_type: "click", listener: () => void) => { clicks.delete(listener); },
      click: () => { for (const listener of [...clicks]) listener(); },
      listenerCount: () => clicks.size
    };
  }
  const notices: NoticePort = {
    show: (message, kind, sticky) => {
      const item = notice();
      shown.push({ message, kind, sticky, notice: item });
      return item;
    },
    showAction: (message, kind, label, action, sticky) => {
      const item = notice();
      shown.push({ message, kind, label, action, sticky, notice: item });
      return item;
    }
  };
  return { notices, shown };
}

export function fakeTourPreferences() {
  let finished = 0;
  const preferences: Pick<Preferences, "tourFinished"> = { tourFinished: () => { finished++; } };
  return { preferences, finished: () => finished };
}

export function fakeTourFlags() {
  let open = false;
  const viewFlags: Pick<ViewFlags, "setTourOpen" | "tourOpen"> = {
    setTourOpen: (value) => { open = value; },
    tourOpen: () => open
  };
  return viewFlags;
}

export function fakeSidePanels() {
  let closed = 0;
  const sidePanels: Pick<SidePanels, "closeAll"> = { closeAll: () => { closed++; } };
  return { sidePanels, closed: () => closed };
}

export function fakeScreen(initial: Partial<ScreenState> = {}) {
  const state: Record<Blocker, boolean> = {
    loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false,
    ...initial
  };
  const screen = (): ScreenState => ({ ...state });
  return { state, screen };
}

export function fakeActions(registry?: ActionRegistry) {
  const calls: { id: string | null; source: ActionSource; input?: unknown }[] = [];
  const actions: Pick<ActionRegistry, "invoke" | "view"> = {
    invoke: (id, source, input) => {
      calls.push(input === undefined ? { id, source } : { id, source, input });
      return registry ? registry.invoke(id, source, input) : { kind: "ran", id };
    },
    view: (id, source) => registry?.view(id, source)
  };
  return { actions, calls };
}

export function fakePreferenceChanges() {
  const listeners = new Set<(change: PreferenceNotice) => void>();
  const changes: PreferenceChanges = {
    onChange: (listener, hearing) => {
      const heard = hearing?.elsewhere === false
        ? (change: PreferenceNotice): void => { if (!change.elsewhere) listener(change); }
        : listener;
      listeners.add(heard);
      return () => { listeners.delete(heard); };
    }
  };
  return {
    changes,
    listenerCount: (): number => listeners.size,
    emit: (change: PreferenceNotice): void => { for (const listener of [...listeners]) listener(change); }
  };
}

export function fakePreferences(initialScale = 1) {
  const notices = fakePreferenceChanges();
  const writes: (string | null)[] = [];
  let value = initialScale;
  const preferences: Pick<Preferences, "scriptScale" | "setScriptScale" | "clearScriptScale"> = {
    scriptScale: () => value,
    setScriptScale: (scale) => {
      value = Math.round(scale * 100) / 100;
      const stored = String(value);
      writes.push(stored);
      notices.emit({ name: "scriptScale", value: stored, elsewhere: false });
    },
    clearScriptScale: () => {
      value = 1;
      writes.push(null);
      notices.emit({ name: "scriptScale", value: null, elsewhere: false });
    }
  };
  return {
    preferences, writes, ...notices,
    changeElsewhere: (scale: number, announced: string | null = String(scale)): void => {
      value = scale;
      notices.emit({ name: "scriptScale", value: announced, elsewhere: true });
    }
  };
}

export function fakeTransitions(arriving: (from: Incoming) => ValidatedDocument) {
  const calls: { kind: "open" | "startNew" | "restore" | "recover"; reason: string | null; destination: DocumentDestination | undefined }[] = [];
  const arrive = (from: Incoming): Arrived => ({ document: arriving(from), forkedFrom: null, kept: false });
  const transitions: Transitions<DocumentDestination> = {
    open: (opening) => {
      calls.push({ kind: "open", reason: opening.reason, destination: opening.destination });
      return arrive(opening.from);
    },
    startNew: (arrival) => {
      calls.push({ kind: "startNew", reason: arrival.reason, destination: arrival.destination });
      return arrive(arrival.from);
    },
    restore: (restoration) => {
      calls.push({ kind: "restore", reason: null, destination: undefined });
      return arrive(restoration.from);
    },
    recover: (recovery) => {
      calls.push({ kind: "recover", reason: recovery.reason, destination: recovery.destination });
      return arrive(recovery.from);
    },
    copyId: () => "d" + "0".repeat(32)
  };
  return { transitions, calls };
}

function listenerSet<L>() {
  const listeners = new Set<L>();
  return {
    listeners,
    add: (listener: L): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
}

export function fakeDocument<Current extends DocumentView = DocumentView>(initial: Current | null = null) {
  let held = initial;
  let epoch = 0;
  const changes = listenerSet<SessionListener>();
  const replaced = listenerSet<() => void>();
  const refreshes = listenerSet<(jobs: ReadonlySet<string>) => void>();
  const numbering = createNumberingReader();
  const document: DocumentReader<Current> = {
    numbering: () => numbering.read(held),
    current: () => held,
    read: (select) => select(held),
    onChange: changes.add,
    onReplaced: replaced.add,
    onRefresh: refreshes.add
  };
  return {
    document,
    lifetime: { epoch: () => epoch },
    replace: (doc: Current | null): void => {
      held = doc;
      epoch++;
      for (const listener of [...replaced.listeners]) listener();
    },
    refresh: (jobs: readonly string[]): void => {
      for (const listener of [...refreshes.listeners]) listener(new Set(jobs));
    },
    listenerCount: (): number => changes.listeners.size + replaced.listeners.size + refreshes.listeners.size
  };
}

export function fakeEdits(answer: CommandOutcome = { kind: "noop" }) {
  const ran: Command[] = [];
  let outcome = answer;
  const edits: Pick<DocumentEdits, "run" | "edit" | "stamps"> = {
    run: (command) => {
      ran.push(command);
      return outcome;
    },
    edit: (command) => {
      ran.push(command);
      return outcome.kind === "applied" || outcome.kind === "committed";
    },
    stamps: { clock: { nowIso: () => "2026-01-01T00:00:00.000Z" }, editor: { name: () => "Tester" } }
  };
  return { edits, ran, answer: (next: CommandOutcome): void => { outcome = next; } };
}

export function fakeUndo() {
  const calls: string[] = [];
  const undo: Pick<UndoControl, "undo" | "redo"> = {
    undo: () => { calls.push("undo"); },
    redo: () => { calls.push("redo"); }
  };
  return { undo, calls };
}

export function fakeSaveState(initial: { unsaved?: boolean; busy?: boolean } = {}) {
  const listeners = new Set<(change: SaveChange) => void>();
  const asked: ("dueNow" | "resume")[] = [];
  const state = { unsaved: !!initial.unsaved, busy: !!initial.busy, autoSaveEnabled: true };
  const saves: SaveState = {
    unsaved: () => state.unsaved,
    busy: () => state.busy,
    onChange: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dueNow: () => { asked.push("dueNow"); },
    resume: () => { asked.push("resume"); },
    setAutoSaveEnabled: (on) => { state.autoSaveEnabled = on; }
  };
  return {
    saves, state, asked,
    listenerCount: (): number => listeners.size,
    emit: (change: SaveChange): void => { for (const listener of [...listeners]) listener(change); }
  };
}

export function fakeOwnership() {
  let epoch = 1;
  const ownership: Operations = {
    capture: (): OperationContext => Object.freeze({
      epoch, docId: "doc", destination: null, destinationGeneration: 0, generation: 0, connection: null, revision: null
    }),
    stillOwns: (ctx) => ctx.epoch === epoch
  };
  return { ownership, replace: (): void => { epoch++; } };
}

export function fakePictures() {
  const held = new Map<string, { ref: ImageRef; bytes: Uint8Array | null }>();
  const persisted: string[] = [];
  let next = 0;
  const add = (bytes: Uint8Array | null, mime: string): ImageRef => {
    const ref: ImageRef = { sha256: (++next).toString(16).padStart(64, "0"), width: 1, height: 1, mime };
    held.set(ref.sha256, { ref, bytes });
    return ref;
  };
  const pictures: PictureStore = {
    has: (sha) => !!held.get(sha)?.bytes,
    intern: (bytes) => bytes.length ? add(bytes, "image/png") : null,
    internDataUrl: (dataUrl) => dataUrl.startsWith("data:image/") ? add(new Uint8Array([1]), dataUrl.slice(5, dataUrl.indexOf(";"))) : null,
    recordFor: (sha) => held.get(sha)?.ref ?? null,
    bytesFor: (sha) => held.get(sha)?.bytes ?? null,
    urlFor: (sha) => held.get(sha)?.bytes ? "blob:" + sha : null,
    dataUrlFor: (sha) => held.get(sha)?.bytes ? "data:" + held.get(sha)?.ref.mime + ";base64,AQ==" : null,
    isDurable: (sha) => persisted.includes(sha),
    queuePersist: (shas) => { persisted.push(...shas); },
    persist: (shas) => {
      persisted.push(...shas);
      return Promise.resolve([]);
    },
    ensureBytes: (shas) => Promise.resolve(shas.filter((sha) => !held.get(sha)?.bytes)),
    imgHtml: (ref, className) => `<img${className ? ` class="${className}"` : ""} data-blob="${ref.sha256}" alt="">`
  };
  return {
    pictures,
    persisted,
    forget: (sha: string): void => {
      const entry = held.get(sha);
      if (entry) entry.bytes = null;
    }
  };
}

export function fakeOnboardingPorts() {
  const state = {
    desktop: false, seed: true, pending: false, firstTab: true,
    prior: false, intent: { type: "blank" }, draft: false, last: null as unknown,
    home: { kind: "none" } as ReturnType<DocumentPlace["home"]>
  };
  const actions = fakeActions();
  const panels = fakeSidePanels();
  let record: ReturnType<Preferences["onboarding"]> = null;
  const recorded: boolean[] = [];
  const choices = new Set<() => void>();
  const ports: OnboardingPorts = {
    startup: { ready: () => null },
    desktop: () => state.desktop,
    actions: actions.actions, sidePanels: panels.sidePanels,
    preferences: {
      onboarding: () => record,
      recordOnboarding: (skipped, at) => { recorded.push(skipped); record = { v: 1, done: true, skipped, at }; }
    },
    place: { home: () => state.home },
    draftResume: { restorePending: () => state.pending },
    seedCheck: { passes: () => state.seed },
    launchFacts: {
      firstTabOfLaunch: () => state.firstTab, hadPriorSession: () => state.prior,
      launchIntent: () => state.intent, hasDraftToRestore: () => state.draft
    },
    lastFile: { load: async () => state.last },
    onFileMenuChoice: (listener) => { choices.add(listener); return () => { choices.delete(listener); }; }
  };
  return { ports, state, actions, panels, recorded, choices };
}
