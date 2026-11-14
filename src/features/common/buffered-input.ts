import type { BufferedFieldBinding, BufferedFieldSurface } from "../../application/editing/buffered-field.ts";
import type { PaintedBeats } from "../../application/editing/painted-beats.ts";
import type { PaintedText } from "../../application/editing/ports.ts";
import type { CommandOutcome } from "../../application/session/document-session.ts";
import type { FlowPos, FlowRange } from "../../core/flow/flow.ts";

export interface BufferedInputPorts {
  readonly field: (surface: BufferedFieldSurface<HTMLInputElement>) => BufferedFieldBinding;
  readonly painted: PaintedBeats;
  readonly report: (outcome: CommandOutcome) => void;
  readonly shown: <T>(edit: () => T) => T;
  readonly repaint: () => void;
  readonly onPainted: (listener: () => void) => () => void;
  readonly beforePaint: (check: () => void) => () => void;
}

export interface BufferedInputField {
  readonly inputs: readonly HTMLInputElement[];
  readonly key: string;
  readonly position: (offset: number) => FlowPos;
  readonly owns: (pos: FlowPos) => boolean;
  readonly stored: () => string | null;
  readonly unsettled?: (text: string) => { readonly reason: string; readonly hold: boolean } | null;
  readonly place?: () => void;
  readonly changed?: () => void;
}

export interface BufferedInput {
  readonly held: () => boolean;
  readonly finish: () => boolean;
  readonly dispose: () => boolean;
}

const TYPES = ["beforeinput", "input", "compositionstart", "compositionend", "keydown"] as const;

const MODIFIERS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead", "Process"]);

interface KeptCaret {
  readonly input: HTMLInputElement;
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

export function bindBufferedInput(form: BufferedInputField, ports: BufferedInputPorts): BufferedInput {
  const { inputs, key } = form, first = inputs[0];
  if (!first) throw new Error("A buffered input needs an input element");
  const doc = first.ownerDocument;
  let composing = false, kept: KeptCaret | null = null, open = true, pressed = false;
  const active = () => inputs.find(input => doc.activeElement === input) ?? null;
  const typing = () => active() ?? first;
  const caretNow = (input: HTMLInputElement): KeptCaret => {
    const start = input.selectionStart ?? 0;
    return { input, start, end: input.selectionEnd ?? start, direction: input.selectionDirection ?? "none", base: ports.painted.base(key) };
  };
  const range = (input: HTMLInputElement): FlowRange => {
    const from = input.selectionStart ?? input.value.length, to = input.selectionEnd ?? from;
    const [anchor, head] = input.selectionDirection === "backward" ? [to, from] : [from, to];
    return { anchor: form.position(anchor), head: form.position(head) };
  };
  function reset(): void {
    const text = form.stored();
    if (text === null) return;
    for (const input of inputs) if (input.value !== text) input.value = text;
    ports.painted.field(key, text);
  }
  const unsettled = form.unsettled;
  const binding = ports.field({
    fields: () => inputs,
    field: rowId => rowId === key ? typing() : null,
    rowId: () => key,
    base: rowId => ports.painted.base(rowId),
    painted: rowId => ports.painted.text(rowId),
    normalize: () => {},
    reset, repaint: reset,
    runs: input => [{ text: input.value, marks: {} }],
    selection: () => { const input = active(); return input ? range(input) : null; },
    composition: value => { if (value !== undefined) composing = value; return composing; },
    restore: (_rowId, selection) => {
      const input = typing();
      if (!input.isConnected || !selection || !form.owns(selection.anchor) || !form.owns(selection.head)) return;
      const { anchor, head } = { anchor: selection.anchor.offset, head: selection.head.offset };
      input.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : anchor < head ? "forward" : "none");
    },
    changed: () => { form.changed?.(); },
    key: pos => form.owns(pos) ? key : null,
    position: (_rowId, offset) => form.position(offset),
    ...unsettled ? { unsettled: (_rowId: string, text: string) => unsettled(text) } : {}
  });
  function step(input: HTMLInputElement, event: Event): void {
    if (event.type === "keydown") {
      const key = event as KeyboardEvent;
      if (binding.keydown(key)) return;
      if (binding.held() && !key.isComposing && key.keyCode !== 229 && !MODIFIERS.has(key.key)) pressed = true;
      return;
    }
    if (event.type === "input") { binding.input(); return; }
    if (event.type === "compositionstart") { binding.start(event, range(input)); return; }
    if (event.type === "compositionend") { binding.end(event as CompositionEvent); return; }
    const native = event as InputEvent, type = native.inputType;
    if (native.isComposing || /Composition/.test(type)) return;
    if (!binding.dirty() && input.value === ports.painted.text(key)) ports.painted.field(key, input.value);
    // why: an input gives no target range, so a collapsed delete is left to the browser and adopted at its input event
    if (type.startsWith("delete") && type !== "deleteByCut" && type !== "deleteByDrag" && input.selectionStart === input.selectionEnd) return;
    // why: Enter sends this before the form's submit, which closes a settled name; a held one is consumed below
    if (type === "insertLineBreak" && !binding.held()) return;
    if (binding.beforeInput(native, range(input), range(input))) return;
    event.preventDefault();
    ports.report({ kind: "rejected", reason: "buffer-unsupported-input" });
  }
  function listener(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    ports.shown(() => { binding.native(event, () => { step(input, event); }); });
  }
  function painted(): void {
    const focused = active(), caret = kept ?? (focused ? caretNow(focused) : null), dirty = binding.dirty();
    kept = null;
    form.place?.();
    if (!dirty) reset();
    if (!caret || !caret.input.isConnected) return;
    const input = caret.input;
    if (doc.activeElement !== input) input.focus({ preventScroll: true });
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
    queueMicrotask(() => { if (!active()) settleHeld(); });
  }
  function selectionMoved(): void {
    const selection = doc.getSelection(), at = selection?.rangeCount ? selection.anchorNode : null, input = active();
    if (!input || at && !(input.form ?? input).contains(at)) settleHeld();
  }
  for (const input of inputs) {
    for (const type of TYPES) input.addEventListener(type, listener);
    input.addEventListener("blur", blurred);
    input.addEventListener("keyup", released);
  }
  doc.addEventListener("selectionchange", selectionMoved);
  const stopPainted = ports.onPainted(painted);
  const stopCheck = ports.beforePaint(() => {
    binding.canPaint();
    const input = active();
    kept = input ? caretNow(input) : null;
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
      for (const input of inputs) {
        for (const type of TYPES) input.removeEventListener(type, listener);
        input.removeEventListener("blur", blurred);
        input.removeEventListener("keyup", released);
      }
      doc.removeEventListener("selectionchange", selectionMoved);
      ports.painted.clear();
      ports.repaint();
      return true;
    }
  };
}
