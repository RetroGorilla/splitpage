import type { BufferedFieldBinding, BufferedFieldSurface } from "../../application/editing/buffered-field.ts";
import { headingFieldKey, unsettledHeading } from "../../application/editing/buffered-field-key.ts";
import type { PaintedBeats } from "../../application/editing/painted-beats.ts";
import type { PaintedText } from "../../application/editing/ports.ts";
import type { CommandOutcome } from "../../application/session/document-session.ts";
import { headingPos } from "../../core/flow/flow.ts";
import type { FlowRange } from "../../core/flow/flow.ts";

export interface SceneNameBufferPorts {
  readonly field: (surface: BufferedFieldSurface<HTMLInputElement>) => BufferedFieldBinding;
  readonly painted: PaintedBeats;
  readonly report: (outcome: CommandOutcome) => void;
  readonly shown: <T>(edit: () => T) => T;
  readonly repaintRows: () => void;
  readonly onPainted: (listener: () => void) => () => void;
  readonly beforePaint: (check: () => void) => () => void;
}

export interface SceneNameBuffer {
  readonly held: () => boolean;
  readonly finish: () => boolean;
  readonly dispose: () => boolean;
}

const TYPES = ["beforeinput", "input", "compositionstart", "compositionend", "keydown"] as const;

const MODIFIERS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Process"]);

interface KeptCaret {
  readonly start: number;
  readonly end: number;
  readonly direction: "forward" | "backward" | "none";
  readonly base: PaintedText | null;
}

function followed(before: PaintedText | null, after: PaintedText | null, offset: number, length: number): number {
  if (!before || !after) return Math.min(offset, length);
  for (let at = offset - 1; at >= 0; at--) {
    const identity = before.identity(at);
    for (let next = 0; identity && next < after.text.length; next++) if (after.identity(next) === identity) return next + 1;
  }
  return 0;
}

export function bindSceneName(form: {
  readonly input: HTMLInputElement; readonly sceneId: string; readonly name: () => string | null; readonly place: () => void
}, ports: SceneNameBufferPorts): SceneNameBuffer {
  const { input, sceneId } = form, key = headingFieldKey(sceneId), stored = form.name;
  let composing = false, kept: KeptCaret | null = null, open = true, pressed = false;
  const focused = () => input.ownerDocument.activeElement === input;
  const caretNow = (): KeptCaret => {
    const start = input.selectionStart ?? 0;
    return { start, end: input.selectionEnd ?? start, direction: input.selectionDirection ?? "none", base: ports.painted.base(key) };
  };
  const range = (): FlowRange => {
    const from = input.selectionStart ?? input.value.length, to = input.selectionEnd ?? from;
    const [anchor, head] = input.selectionDirection === "backward" ? [to, from] : [from, to];
    return { anchor: headingPos(sceneId, anchor), head: headingPos(sceneId, head) };
  };
  function reset(): void {
    const name = stored();
    if (name === null) return;
    input.value = name;
    ports.painted.field(key, name);
  }
  const binding = ports.field({
    fields: () => [input],
    field: rowId => rowId === key ? input : null,
    rowId: () => key,
    base: rowId => ports.painted.base(rowId),
    painted: rowId => ports.painted.text(rowId),
    normalize: () => {},
    reset, repaint: reset,
    runs: () => [{ text: input.value, marks: {} }],
    selection: () => focused() ? range() : null,
    composition: value => { if (value !== undefined) composing = value; return composing; },
    restore: (_rowId, selection) => {
      if (!input.isConnected || selection?.anchor.kind !== "heading" || selection.head.kind !== "heading") return;
      const { anchor, head } = { anchor: selection.anchor.offset, head: selection.head.offset };
      input.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : anchor < head ? "forward" : "none");
    },
    changed: () => {},
    key: pos => pos.kind === "heading" && pos.sceneId === sceneId ? key : null,
    position: (_rowId, offset) => headingPos(sceneId, offset),
    unsettled: (_rowId, text) => unsettledHeading(text)
  });
  function step(event: Event): void {
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      if (binding.held() && !key.isComposing && key.keyCode !== 229 && !MODIFIERS.has(key.key)) pressed = true;
      binding.keydown(key); return;
    }
    if (event.type === "input") { binding.input(); return; }
    if (event.type === "compositionstart") { binding.start(event, range()); return; }
    if (event.type === "compositionend") { binding.end(event as CompositionEvent); return; }
    const native = event as InputEvent, type = native.inputType;
    if (native.isComposing || /Composition/.test(type)) return;
    if (!binding.dirty() && input.value === ports.painted.text(key)) ports.painted.field(key, input.value);
    // why: an input gives no target range, so a collapsed delete is left to the browser and adopted at its input event
    if (type.startsWith("delete") && type !== "deleteByCut" && type !== "deleteByDrag" && input.selectionStart === input.selectionEnd) return;
    // why: Enter sends this before the form's submit, which closes a settled name; a held one is consumed below
    if (type === "insertLineBreak" && !binding.held()) return;
    if (binding.beforeInput(native, range(), range())) return;
    event.preventDefault();
    ports.report({ kind: "rejected", reason: "buffer-unsupported-input" });
  }
  function listener(event: Event): void {
    ports.shown(() => { binding.native(event, () => { step(event); }); });
  }
  function painted(): void {
    const caret = kept ?? (focused() ? caretNow() : null), dirty = binding.dirty();
    kept = null;
    form.place();
    if (!dirty) reset();
    if (!caret || !input.isConnected) return;
    if (!focused()) input.focus({ preventScroll: true });
    const after = ports.painted.base(key), length = input.value.length;
    const map = (offset: number) => dirty ? Math.min(offset, length) : followed(caret.base, after, offset, length);
    input.setSelectionRange(map(caret.start), map(caret.end), caret.direction);
  }
  function settleHeld(): void {
    if (open && binding.held()) ports.shown(() => binding.finish());
  }
  function released(): void {
    // why: some keys on an input send no input event (an empty Backspace, a redo with no history), so a key that
    // inserted nothing ends the hold once the browser's default has run
    if (pressed) settleHeld();
    pressed = false;
  }
  function blurred(): void {
    // why: a repaint re-homes the form, blurring it until the paint refocuses; the hold ends only if focus stays away
    queueMicrotask(() => { if (!focused()) settleHeld(); });
  }
  function selectionMoved(): void {
    const selection = input.ownerDocument.getSelection(), at = selection?.rangeCount ? selection.anchorNode : null;
    if (!focused() || at && !input.form?.contains(at)) settleHeld();
  }
  for (const type of TYPES) input.addEventListener(type, listener);
  input.addEventListener("blur", blurred);
  input.addEventListener("keyup", released);
  input.ownerDocument.addEventListener("selectionchange", selectionMoved);
  const stopPainted = ports.onPainted(painted);
  const stopCheck = ports.beforePaint(() => {
    binding.canPaint();
    kept = focused() ? caretNow() : null;
  });
  reset();
  return {
    held: binding.held,
    finish: () => ports.shown(() => binding.finish()),
    dispose: () => {
      if (!open) return true;
      if (!ports.shown(() => binding.dispose())) return false;
      open = false;
      stopPainted(); stopCheck();
      for (const type of TYPES) input.removeEventListener(type, listener);
      input.removeEventListener("blur", blurred);
      input.removeEventListener("keyup", released);
      input.ownerDocument.removeEventListener("selectionchange", selectionMoved);
      ports.painted.clear();
      ports.repaintRows();
      return true;
    }
  };
}
