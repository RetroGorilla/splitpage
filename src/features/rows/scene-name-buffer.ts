import type { BufferedFieldBinding, BufferedFieldSurface } from "../../application/editing/buffered-field.ts";
import { headingFieldKey, unsettledHeading } from "../../application/editing/buffered-field-key.ts";
import type { PaintedBeats } from "../../application/editing/painted-beats.ts";
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

function movedCaret(before: string, after: string, offset: number): number {
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  if (offset <= start) return offset;
  return offset >= before.length - end ? offset + after.length - before.length : after.length - end;
}

export function bindSceneName(form: {
  readonly input: HTMLInputElement; readonly sceneId: string; readonly name: () => string | null; readonly place: () => void
}, ports: SceneNameBufferPorts): SceneNameBuffer {
  const { input, sceneId } = form, key = headingFieldKey(sceneId), stored = form.name;
  let composing = false, kept: readonly [number, number] | null = null;
  const focused = () => input.ownerDocument.activeElement === input;
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
      const from = Math.min(selection.anchor.offset, selection.head.offset), to = Math.max(selection.anchor.offset, selection.head.offset);
      input.setSelectionRange(from, to);
    },
    changed: () => {},
    key: pos => pos.kind === "heading" && pos.sceneId === sceneId ? key : null,
    position: (_rowId, offset) => headingPos(sceneId, offset),
    unsettled: (_rowId, text) => unsettledHeading(text)
  });
  function step(event: Event): void {
    if (event.type === "keydown") { binding.keydown(event as KeyboardEvent); return; }
    if (event.type === "input") { binding.input(); return; }
    if (event.type === "compositionstart") { binding.start(event, range()); return; }
    if (event.type === "compositionend") { binding.end(event as CompositionEvent); return; }
    const native = event as InputEvent, type = native.inputType;
    if (native.isComposing || /Composition/.test(type)) return;
    if (!binding.dirty() && input.value === ports.painted.text(key)) ports.painted.field(key, input.value);
    // why: an input gives no target range, so a collapsed delete is left to the browser and adopted at its input event
    if (type.startsWith("delete") && type !== "deleteByCut" && type !== "deleteByDrag" && input.selectionStart === input.selectionEnd) return;
    // why: a paste or drop is an insertion into the held name, so refusing it must not also end the hold
    const refusedInsertion = binding.held() && type.startsWith("insert") && type !== "insertText" && type !== "insertReplacementText";
    if (!refusedInsertion && binding.beforeInput(native, range(), range())) return;
    event.preventDefault();
    ports.report({ kind: "rejected", reason: "buffer-unsupported-input" });
  }
  function listener(event: Event): void {
    ports.shown(() => { binding.native(event, () => { step(event); }); });
  }
  function painted(): void {
    const caret = kept ?? (focused() ? [input.selectionStart ?? 0, input.selectionEnd ?? 0] as const : null), before = input.value;
    kept = null;
    form.place();
    if (!binding.dirty()) reset();
    if (!caret || !input.isConnected) return;
    if (!focused()) input.focus({ preventScroll: true });
    input.setSelectionRange(movedCaret(before, input.value, caret[0]), movedCaret(before, input.value, caret[1]));
  }
  for (const type of TYPES) input.addEventListener(type, listener);
  const stopPainted = ports.onPainted(painted);
  const stopCheck = ports.beforePaint(() => {
    binding.canPaint();
    kept = focused() ? [input.selectionStart ?? 0, input.selectionEnd ?? 0] : null;
  });
  reset();
  let open = true;
  return {
    held: binding.held,
    finish: () => ports.shown(() => binding.finish()),
    dispose: () => {
      if (!open) return true;
      if (!ports.shown(() => binding.dispose())) return false;
      open = false;
      stopPainted(); stopCheck();
      for (const type of TYPES) input.removeEventListener(type, listener);
      ports.painted.clear();
      ports.repaintRows();
      return true;
    }
  };
}
