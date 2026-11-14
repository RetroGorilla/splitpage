import type { BufferedTextCommit, BufferedTextEdit, PaintedText } from "./ports.ts";
import type { CommandOutcome } from "../session/document-session.ts";
import type { SharedDocumentSession } from "../session/shared-session.ts";
import { beatPos } from "../../core/flow/flow.ts";
import type { FlowPos, FlowRange } from "../../core/flow/flow.ts";
import { projection } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";
import { alignSpaceForm, bufferedNativeReplacement, foldedNativeReplacement, foldedNativeSplice, sameUpToSpaceForm } from "../../core/collab/buffer.ts";

export interface BufferedFieldPorts extends Pick<BufferedTextCommit, "open">, Pick<SharedDocumentSession, "beforeCommand"> {
  readonly missingBase: (rowId: string) => void;
  readonly recovered: (rowId: string) => void;
  readonly report: (outcome: CommandOutcome) => void;
}

export interface BufferedFieldEvent {
  readonly type: string;
  readonly preventDefault: () => void;
}

export interface BufferedFieldKey extends BufferedFieldEvent {
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
}

export interface BufferedFieldBinding {
  readonly native: (event: BufferedFieldEvent, dispatch: () => void) => void;
  readonly beforeInput: (event: BufferedFieldEvent & { readonly inputType: string; readonly isComposing: boolean; readonly data?: string | null },
    range: FlowRange | null, native: FlowRange | null) => boolean;
  readonly input: () => void;
  readonly discardUnchangedInput: () => void;
  readonly start: (event: BufferedFieldEvent, range: FlowRange | null) => void;
  readonly keydown: (event: BufferedFieldKey) => boolean;
  readonly end: (event: { readonly data: string }) => void;
  readonly finish: () => boolean;
  readonly settledFor: (event: BufferedFieldEvent) => boolean;
  readonly canPaint: () => boolean;
  readonly dirty: () => boolean;
  readonly held: () => boolean;
  readonly moved: (range: FlowRange | null) => void;
  readonly base: (rowId: string) => PaintedText | null;
  readonly dispose: () => boolean;
}

export interface BufferedFieldSurface<E> {
  readonly foldSpaceForm?: boolean;
  readonly fields: () => Iterable<E>;
  readonly field: (rowId: string) => E | null;
  readonly rowId: (field: E) => string;
  readonly base: (rowId: string) => PaintedText | null;
  readonly painted: (rowId: string) => string | undefined;
  readonly normalize: () => void;
  readonly reset: (rowId: string) => void;
  readonly runs: (field: E) => readonly Run[];
  readonly text?: (field: E) => string;
  readonly selection: () => FlowRange | null;
  readonly composition: (value?: boolean) => boolean;
  readonly repaint: (rowId: string) => void;
  readonly restore: (rowId: string, selection: FlowRange | undefined) => void;
  readonly changed: () => void;
  readonly key?: (pos: FlowPos) => string | null;
  readonly position?: (key: string, offset: number) => FlowPos;
  readonly unsettled?: (key: string, text: string) => { readonly reason: string; readonly hold: boolean } | null;
}

export function createBufferedField<E>(ports: BufferedFieldPorts, surface: BufferedFieldSurface<E>): BufferedFieldBinding {
  let active: { rowId: string; beat: E; base: PaintedText; edit: BufferedTextEdit; fault: boolean } | null = null;
  let target: readonly [number, number] | null = null;
  let typed: string | null = null;
  const same = surface.foldSpaceForm ? sameUpToSpaceForm : (a: string, b: string) => a === b;
  let ended = false;
  let committing = false;
  let refusedComposition = false;
  let composedFromHold: string | null = null;
  const keyOf = surface.key ?? ((pos: FlowPos) => pos.kind === "beat" ? pos.rowId : null);
  const at = surface.position ?? beatPos;
  const text = surface.text ?? ((field: E) => projection(surface.runs(field)));
  function one(range: FlowRange | null): string | null {
    const key = range ? keyOf(range.anchor) : null;
    return key !== null && range && keyOf(range.head) === key ? key : null;
  }

  function checkpoint(type: string): BufferedFieldEvent {
    return { type, preventDefault: () => {} };
  }

  function refuse(event: BufferedFieldEvent, reason: string): void {
    event.preventDefault();
    ports.report({ kind: "rejected", reason });
  }

  function begin(event: BufferedFieldEvent, range: FlowRange | null, repaint = true): boolean {
    const rowId = one(range);
    if (rowId === null || !range) { refuse(event, "buffer-unsupported-target"); return false; }
    if (active?.rowId === rowId && active.edit.isOpen()) return true;
    if (active && !settle()) { event.preventDefault(); return false; }
    const base = surface.base(rowId), beat = surface.field(rowId);
    if (!base || !beat) {
      event.preventDefault(); ports.missingBase(rowId);
      if (repaint) { surface.repaint(rowId); surface.restore(rowId, range); }
      return false;
    }
    let edit: BufferedTextEdit | null;
    try { edit = ports.open(rowId, base); }
    catch (error) { event.preventDefault(); ports.report({ kind: "failed", error }); return false; }
    if (!edit || !edit.isOpen()) {
      refuse(event, "buffer-unavailable");
      if (repaint) { surface.repaint(rowId); surface.restore(rowId, range); }
      return false;
    }
    active = { rowId, beat, base, edit, fault: false };
    return true;
  }

  function reconcile(): void {
    if (!active || !active.edit.isOpen() || active.fault) return;
    const next = text(active.beat), before = active.edit.text();
    if (!target) {
      const replacement = surface.foldSpaceForm ? foldedNativeReplacement(before, next) : bufferedNativeReplacement(before, next);
      if (replacement) active.edit.replace(replacement.from, replacement.to, replacement.insert);
      return;
    }
    if (same(next, before)) return;
    if (surface.foldSpaceForm) {
      const splice = foldedNativeSplice(before, next, target[0], target[1], typed);
      if (!splice) { active.fault = true; ports.report({ kind: "rejected", reason: "buffer-native-evidence" }); return; }
      active.edit.replace(splice.from, splice.to, splice.insert); target = null; return;
    }
    const [from, to] = target, inserted = next.length - before.length + to - from;
    if (inserted < 0 || next.slice(0, from) !== before.slice(0, from) || next.slice(from + inserted) !== before.slice(to)) {
      active.fault = true; ports.report({ kind: "rejected", reason: "buffer-native-evidence" }); return;
    }
    active.edit.replace(from, to, next.slice(from, from + inserted)); target = null;
  }

  function ownership(event: BufferedFieldEvent): { readonly ok: boolean; readonly adopted: boolean } {
    surface.normalize();
    let ok = true, adopted = false;
    for (const beat of surface.fields()) {
      if (active?.beat === beat && active.edit.isOpen()) continue;
      const rowId = surface.rowId(beat), shown = surface.painted(rowId), next = text(beat);
      if (active?.beat === beat && !active.edit.isOpen() && same(next, active.edit.text())) { surface.reset(rowId); continue; }
      if (shown !== undefined && same(next, shown)) continue;
      if (active?.edit.isOpen()) { refuse(event, "buffer-pending"); surface.reset(rowId); ok = false; continue; }
      const pos = at(rowId, next.length);
      if (!begin(event, { anchor: pos, head: pos }, false)) { surface.reset(rowId); ok = false; continue; }
      reconcile(); adopted = true;
    }
    return { ok, adopted };
  }

  function recover(held: NonNullable<typeof active>, refusal: CommandOutcome, selection: readonly [number, number] | undefined): boolean {
    let kept: CommandOutcome | null;
    committing = true;
    try { kept = held.edit.recover(surface.runs(held.beat)); }
    catch (error) { kept = { kind: "failed", error }; }
    finally { committing = false; }
    if (held.edit.isOpen()) { ports.report(kept ?? refusal); return false; }
    active = null; target = null;
    surface.repaint(held.rowId); const shown = surface.painted(held.rowId) !== undefined;
    surface.restore(held.rowId, selection && shown ? { anchor: at(held.rowId, selection[0]), head: at(held.rowId, selection[1]) } : undefined);
    surface.changed();
    ports.recovered(held.rowId);
    if (kept && (kept.kind === "failed" || kept.kind === "committed" && kept.errors.length)) ports.report(kept);
    return true;
  }

  function settle(): boolean {
    if (surface.composition()) { ports.report({ kind: "rejected", reason: "buffer-composition" }); return false; }
    if (!active) return true;
    reconcile();
    if (committing || target || active.fault) {
      if (!active.fault) ports.report({ kind: "rejected", reason: "buffer-pending" });
      return false;
    }
    const held = active, range = surface.selection();
    const selection: readonly [number, number] | undefined = range && one(range) === held.rowId ? [range.anchor.offset, range.head.offset] : undefined;
    const unsettled = surface.unsettled?.(held.rowId, held.edit.text());
    if (unsettled) {
      active = null; target = null;
      surface.reset(held.rowId);
      try { held.edit.cancel(); } catch (error) { ports.report({ kind: "failed", error }); }
      surface.repaint(held.rowId);
      surface.restore(held.rowId, selection ? { anchor: at(held.rowId, selection[0]), head: at(held.rowId, selection[1]) } : undefined);
      ports.report({ kind: "rejected", reason: unsettled.reason });
      return true;
    }
    let outcome: ReturnType<BufferedTextEdit["commit"]>;
    committing = true;
    try {
      const runs = surface.runs(held.beat);
      outcome = held.edit.commit(surface.foldSpaceForm ? alignSpaceForm(runs, held.edit.text()) ?? runs : runs, selection);
    }
    catch (error) { outcome = { kind: "failed", error }; }
    finally { committing = false; }
    if (held.edit.isOpen()) return recover(held, outcome, selection);
    active = null; target = null;
    surface.repaint(held.rowId); surface.restore(held.rowId, outcome.selection);
    surface.changed();
    if (outcome.kind === "failed" || outcome.kind === "rejected" || outcome.kind === "committed" && outcome.errors.length) ports.report(outcome);
    return true;
  }

  function holding(): boolean {
    return !!active && active.edit.isOpen() && !!surface.unsettled?.(active.rowId, active.edit.text())?.hold;
  }

  function finish(): boolean {
    const checked = ownership(checkpoint("settle"));
    return checked.ok && settle();
  }

  function settledFor(event: BufferedFieldEvent): boolean {
    // why: input that ends a held empty heading would act on the name the person did not see, so it is consumed
    const held = holding();
    if (finish() && !held) return true;
    event.preventDefault(); return false;
  }

  const stopAdmission = ports.beforeCommand(() => committing || finish());

  return {
    native: (event, dispatch) => {
      if (event.type === "compositionstart") surface.composition(true);
      const before = ownership(event);
      if (before.ok || event.type === "compositionend") dispatch();
      const after = ownership(event);
      if ((before.adopted || after.adopted) && !surface.composition() && !target && !holding()) settle();
    },
    beforeInput: (event, range, native) => {
      const type = event.inputType, intended = native ?? range;
      if (refusedComposition && !event.isComposing && !/Composition/.test(type) && one(intended) !== null) refusedComposition = false;
      if (refusedComposition && (event.isComposing || /^(insert|delete)/.test(type))) { refuse(event, "buffer-unsupported-target"); return true; }
      if (ended && /Composition/.test(type)) { event.preventDefault(); return true; }
      ended = false;
      if (type === "deleteByCut" || type === "deleteByDrag" || !/^(insertText|insertReplacementText|insertCompositionText|insertFromComposition|delete.*)$/.test(type)) {
        return !settledFor(event);
      }
      const ends = intended ? [keyOf(intended.anchor), keyOf(intended.head)] : [];
      if (!event.isComposing && !/Composition/.test(type) && ends[0] && ends[1] && ends[0] !== ends[1]) {
        if (!settledFor(event)) return true;
        const missing = ends.find(key => key && !surface.base(key));
        if (missing) { event.preventDefault(); ports.missingBase(missing); surface.repaint(missing); return true; }
        return false;
      }
      const collapsed = one(intended);
      if (type.startsWith("delete") && intended && collapsed !== null && intended.anchor.offset === intended.head.offset) {
        const rowId = collapsed, base = active?.rowId === rowId ? active.base : surface.base(rowId);
        if (!base) { begin(event, intended); return true; }
        const length = active?.rowId === rowId ? active.edit.text().length : base.text.length, offset = intended.head.offset;
        if (type === "deleteContentBackward" && offset === 0 || type === "deleteContentForward" && offset === length) {
          return !settledFor(event);
        }
        refuse(event, "buffer-native-target"); return true;
      }
      if (!begin(event, intended) || !intended) return true;
      const from = Math.min(intended.anchor.offset, intended.head.offset), to = Math.max(intended.anchor.offset, intended.head.offset);
      target = [from, to]; typed = event.data ?? null;
      return true;
    },
    input: () => {
      if (!active || !active.edit.isOpen()) return;
      reconcile();
      if (target && !active.fault && same(text(active.beat), active.edit.text())) {
        const [from, to] = target, kept = active.edit.text().slice(from, to);
        active.edit.replace(from, to, surface.foldSpaceForm && typed !== null && sameUpToSpaceForm(typed, kept) ? typed : kept); target = null;
      }
      if (!surface.composition() && !holding()) finish();
    },
    discardUnchangedInput: () => {
      if (!target || !active || active.fault || surface.composition() || !same(text(active.beat), active.edit.text())) return;
      target = null; typed = null;
      if (!holding()) finish();
    },
    start: (event, range) => {
      ended = false; refusedComposition = false; composedFromHold = null;
      if (one(range) === null) {
        surface.composition(true); refusedComposition = true; refuse(event, "buffer-unsupported-target"); return;
      }
      const hold = active && holding() && one(range) === active.rowId ? surface.unsettled?.(active.rowId, active.edit.text()) : null;
      if (begin(event, range)) composedFromHold = hold?.reason ?? null;
      surface.composition(true);
    },
    keydown: event => {
      if (event.isComposing || event.keyCode === 229) return false;
      refusedComposition = false; ended = false;
      // why: a key held down to clear a field repeats on the emptied field; only a fresh press ends the hold it made
      if (event.repeat && holding()) { event.preventDefault(); return true; }
      return false;
    },
    end: event => {
      surface.composition(false); ended = true;
      const heldReason = composedFromHold; composedFromHold = null;
      if (refusedComposition) return;
      if (!active) return;
      if (!event.data) {
        const held = active; active = null; target = null;
        surface.reset(held.rowId);
        try { held.edit.cancel(); } catch (error) { ports.report({ kind: "failed", error }); }
        surface.repaint(held.rowId); surface.restore(held.rowId, undefined);
        if (heldReason !== null) ports.report({ kind: "rejected", reason: heldReason });
      } else finish();
    },
    finish,
    settledFor,
    canPaint: () => {
      const checked = ownership(checkpoint("paint"));
      if (checked.adopted && !surface.composition() && !holding()) settle();
      return checked.ok && !active && !surface.composition();
    },
    dirty: () => active !== null,
    held: holding,
    moved: range => { if (active && holding() && !surface.composition() && one(range) !== active.rowId) finish(); },
    base: rowId => active?.rowId === rowId ? active.base : null,
    dispose: () => {
      if (!finish()) return false;
      stopAdmission(); target = null; surface.composition(false);
      return true;
    }
  };
}
