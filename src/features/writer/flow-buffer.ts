import type { BufferedTextCommit, BufferedTextEdit, PaintedText } from "../../application/editing/ports.ts";
import type { CommandOutcome } from "../../application/session/document-session.ts";
import type { SharedDocumentSession } from "../../application/session/shared-session.ts";
import type { FlowRange } from "../../core/flow/flow.ts";
import { projection } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";

export interface WriterBufferPorts extends Pick<BufferedTextCommit, "open">, Pick<SharedDocumentSession, "beforeCommand"> {
  readonly missingBase: (rowId: string) => void;
  readonly report: (outcome: CommandOutcome) => void;
}

export interface WriterBufferBinding {
  readonly beforeInput: (event: InputEvent, range: FlowRange | null, native: FlowRange | null) => boolean;
  readonly input: () => void;
  readonly start: (event: Event, range: FlowRange | null) => void;
  readonly keydown: (event: KeyboardEvent) => void;
  readonly end: (event: CompositionEvent) => void;
  readonly finish: () => boolean;
  readonly dirty: () => boolean;
  readonly base: (rowId: string) => PaintedText | null;
  readonly dispose: () => boolean;
}

export function createWriterBuffer(ports: WriterBufferPorts, surface: {
  readonly root: HTMLElement;
  readonly base: (rowId: string) => PaintedText | null;
  readonly runs: (beat: HTMLElement) => readonly Run[];
  readonly selection: () => FlowRange | null;
  readonly composition: (value?: boolean) => boolean;
  readonly repaint: (rowId: string) => void;
  readonly restore: (rowId: string, selection: FlowRange | undefined) => void;
  readonly changed: () => void;
}): WriterBufferBinding {
  let active: { rowId: string; beat: HTMLElement; base: PaintedText; edit: BufferedTextEdit; fault: boolean } | null = null;
  let target: readonly [number, number] | null = null;
  let ended = false;
  let committing = false;
  let refusedComposition = false;

  function refuse(event: Event, reason: string): void {
    event.preventDefault();
    ports.report({ kind: "rejected", reason });
  }

  function begin(event: Event, range: FlowRange | null): boolean {
    if (!range || range.anchor.kind !== "beat" || range.head.kind !== "beat" || range.anchor.rowId !== range.head.rowId) {
      refuse(event, "buffer-unsupported-target"); return false;
    }
    const rowId = range.head.rowId;
    if (active?.rowId === rowId) return true;
    if (!finish()) { refuse(event, "buffer-pending"); return false; }
    const base = surface.base(rowId), beat = surface.root.querySelector<HTMLElement>('.wr-beat[data-id="' + CSS.escape(rowId) + '"]');
    if (!base || !beat) {
      event.preventDefault(); ports.missingBase(rowId);
      surface.repaint(rowId); surface.restore(rowId, range);
      return false;
    }
    let edit: BufferedTextEdit | null;
    try { edit = ports.open(rowId, base); }
    catch (error) { event.preventDefault(); ports.report({ kind: "failed", error }); return false; }
    if (!edit || !edit.isOpen()) {
      refuse(event, "buffer-unavailable"); surface.repaint(rowId); surface.restore(rowId, range); return false;
    }
    active = { rowId, beat, base, edit, fault: false };
    return true;
  }

  function finish(): boolean {
    if (!active) return true;
    if (committing || target || active.fault) return false;
    if (surface.composition()) { surface.composition(false); ended = true; }
    const held = active, range = surface.selection();
    const selection: readonly [number, number] | undefined = range?.anchor.kind === "beat" && range.head.kind === "beat"
      && range.anchor.rowId === held.rowId && range.head.rowId === held.rowId ? [range.anchor.offset, range.head.offset] : undefined;
    let outcome: ReturnType<BufferedTextEdit["commit"]>;
    committing = true;
    try { outcome = held.edit.commit(surface.runs(held.beat), selection); }
    catch (error) { outcome = { kind: "failed", error }; }
    finally { committing = false; }
    if (held.edit.isOpen()) { ports.report(outcome); return false; }
    active = null; target = null;
    surface.repaint(held.rowId); surface.restore(held.rowId, outcome.selection);
    surface.changed();
    if (outcome.kind === "failed" || outcome.kind === "rejected" || outcome.kind === "committed" && outcome.errors.length) ports.report(outcome);
    return true;
  }

  const stopAdmission = ports.beforeCommand(() => committing || finish());

  return {
    beforeInput: (event, range, native) => {
      const type = event.inputType, intended = native ?? range;
      if (refusedComposition && !event.isComposing && !/Composition/.test(type) && intended?.anchor.kind === "beat"
        && intended.head.kind === "beat" && intended.anchor.rowId === intended.head.rowId) refusedComposition = false;
      if (refusedComposition && (event.isComposing || /^(insert|delete)/.test(type))) { refuse(event, "buffer-unsupported-target"); return true; }
      if (ended && /Composition/.test(type)) { event.preventDefault(); return true; }
      ended = false;
      if (type === "deleteByCut" || type === "deleteByDrag" || !/^(insertText|insertReplacementText|insertCompositionText|insertFromComposition|delete.*)$/.test(type)) {
        if (!finish()) { refuse(event, "buffer-pending"); return true; }
        return false;
      }
      if (!event.isComposing && !/Composition/.test(type) && intended?.anchor.kind === "beat" && intended.head.kind === "beat"
        && intended.anchor.rowId !== intended.head.rowId) {
        if (!finish()) { refuse(event, "buffer-pending"); return true; }
        const missing = [intended.anchor.rowId, intended.head.rowId].find(rowId => !surface.base(rowId));
        if (missing) { event.preventDefault(); ports.missingBase(missing); surface.repaint(missing); return true; }
        return false;
      }
      if (type.startsWith("delete") && intended?.anchor.kind === "beat" && intended.head.kind === "beat"
        && intended.anchor.rowId === intended.head.rowId && intended.anchor.offset === intended.head.offset) {
        const rowId = intended.head.rowId, base = active?.rowId === rowId ? active.base : surface.base(rowId);
        if (!base) { begin(event, intended); return true; }
        const length = active?.rowId === rowId ? active.edit.text().length : base.text.length, at = intended.head.offset;
        if (type === "deleteContentBackward" && at === 0 || type === "deleteContentForward" && at === length) {
          if (!finish()) { refuse(event, "buffer-pending"); return true; }
          return false;
        }
        refuse(event, "buffer-native-target"); return true;
      }
      if (!begin(event, intended)) return true;
      if (!intended || intended.anchor.kind !== "beat" || intended.head.kind !== "beat") return true;
      const from = Math.min(intended.anchor.offset, intended.head.offset), to = Math.max(intended.anchor.offset, intended.head.offset);
      target = [from, to];
      return true;
    },
    input: () => {
      if (!active) return;
      const next = projection(surface.runs(active.beat)), before = active.edit.text();
      const [from, to] = target ?? [-1, -1], inserted = next.length - before.length + to - from;
      if (from < 0 || inserted < 0 || next.slice(0, from) !== before.slice(0, from) || next.slice(from + inserted) !== before.slice(to)) {
        active.fault = true; ports.report({ kind: "rejected", reason: "buffer-native-evidence" }); return;
      }
      active.edit.replace(from, to, next.slice(from, from + inserted));
      target = null;
      if (!surface.composition()) finish();
    },
    start: (event, range) => {
      ended = false; refusedComposition = false;
      if (!range || range.anchor.kind !== "beat" || range.head.kind !== "beat" || range.anchor.rowId !== range.head.rowId) {
        surface.composition(true); refusedComposition = true; refuse(event, "buffer-unsupported-target"); return;
      }
      begin(event, range); surface.composition(true);
    },
    keydown: event => { if (!event.isComposing && event.keyCode !== 229) { refusedComposition = false; ended = false; } },
    end: event => {
      surface.composition(false); ended = true;
      if (refusedComposition) return;
      if (!active) return;
      if (!event.data) {
        const held = active; active = null; target = null;
        try { held.edit.cancel(); } catch (error) { ports.report({ kind: "failed", error }); }
        surface.repaint(held.rowId); surface.restore(held.rowId, undefined);
      } else finish();
    },
    finish,
    dirty: () => active !== null,
    base: rowId => active?.rowId === rowId ? active.base : null,
    dispose: () => {
      if (!finish()) return false;
      stopAdmission(); target = null; surface.composition(false);
      return true;
    }
  };
}
