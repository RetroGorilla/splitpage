import { test } from "node:test";
import assert from "node:assert/strict";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import type { BufferedFieldEvent } from "../../../src/application/editing/buffered-field.ts";
import type { BufferedTextEdit, PaintedText } from "../../../src/application/editing/ports.ts";
import type { CommandOutcome } from "../../../src/application/session/document-session.ts";
import type { SharedContentRef } from "../../../src/core/collab/operations.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";
import { projection } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";

const NBSP = " ";

interface Field { readonly rowId: string; shown: string }

function fieldBinding(text: string, foldSpaceForm: boolean | undefined) {
  const field: Field = { rowId: "R1", shown: text };
  let painted = text, revision = 1, composing = false;
  const reports: CommandOutcome[] = [], replaced: [number, number, string][][] = [], committed: string[] = [];
  const base = (): PaintedText => ({ revision, text: painted, identity: index => index < painted.length ? ("u" + index) as SharedContentRef : null });
  const binding = createBufferedField({
    open: (_rowId, from) => {
      let value = from.text, open = true;
      const calls: [number, number, string][] = [];
      replaced.push(calls);
      const edit: BufferedTextEdit = {
        isOpen: () => open,
        text: () => value,
        replace: (start, end, insert) => { calls.push([start, end, insert]); value = value.slice(0, start) + insert + value.slice(end); },
        commit: (runs: readonly Run[]) => { committed.push(projection(runs)); painted = value; revision++; open = false; return { kind: "noop" }; },
        recover: () => null,
        cancel: () => { open = false; }
      };
      return edit;
    },
    beforeCommand: () => () => {},
    missingBase: () => {}, recovered: () => {},
    report: outcome => { reports.push(outcome); }
  }, {
    ...(foldSpaceForm === undefined ? {} : { foldSpaceForm }),
    fields: () => [field],
    field: rowId => rowId === field.rowId ? field : null,
    rowId: shown => shown.rowId,
    base: () => base(),
    painted: () => painted,
    normalize: () => {},
    reset: () => { field.shown = painted; },
    runs: shown => [{ text: shown.shown, marks: {} }],
    selection: () => null,
    composition: value => { if (value !== undefined) composing = value; return composing; },
    repaint: () => {},
    restore: () => {},
    changed: () => {}
  });
  function event(type: string, extra: Record<string, unknown> = {}): BufferedFieldEvent & { inputType: string; isComposing: boolean; data: string | null; prevented: boolean } {
    const made = { type, inputType: "", isComposing: false, data: null, prevented: false, preventDefault: () => { made.prevented = true; }, ...extra };
    return made;
  }
  function key(from: number, to: number, after: string, inputType: string, data: string | null): boolean {
    const before = event("beforeinput", { inputType, data }), range = { anchor: beatPos("R1", from), head: beatPos("R1", to) };
    binding.native(before, () => { binding.beforeInput(before, null, range); });
    if (before.prevented) return false;
    field.shown = after;
    binding.native(event("input", { inputType, data }), () => { binding.input(); });
    return true;
  }
  return { binding, field, key, reports, replaced, committed, painted: () => painted, adopt: (after: string) => {
    field.shown = after;
    return binding.finish();
  } };
}

test("rule 55, T03 Split native whitespace: the space the browser shows as U+00A0 beside the Backspace target keeps its stored form and the next Backspace deletes it", () => {
  const page = fieldBinding("the the", true);
  assert.equal(page.key(6, 7, "the th", "deleteContentBackward", null), true);
  assert.equal(page.key(5, 6, "the t", "deleteContentBackward", null), true);
  assert.equal(page.key(4, 5, "the" + NBSP, "deleteContentBackward", null), true);
  assert.equal(page.painted(), "the ");
  assert.equal(page.key(3, 4, "the", "deleteContentBackward", null), true);
  assert.deepEqual(page.replaced, [[[6, 7, ""]], [[5, 6, ""]], [[4, 5, ""]], [[3, 4, ""]]]);
  assert.deepEqual(page.committed, ["the th", "the t", "the ", "the"]);
  assert.deepEqual([page.reports, page.painted()], [[], "the"]);
});

test("rule 55, the Writer keeps exact comparison: without foldSpaceForm the same third Backspace is refused as native evidence", () => {
  for (const foldSpaceForm of [undefined, false]) {
    const page = fieldBinding("the t", foldSpaceForm);
    assert.equal(page.key(4, 5, "the" + NBSP, "deleteContentBackward", null), true);
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-native-evidence" }]);
    assert.deepEqual([page.committed, page.replaced, page.painted()], [[], [[]], "the t"]);
  }
});

test("rule 55: a typed space the browser shows as U+00A0 is committed as U+0020 and the shown field stays owned", () => {
  const page = fieldBinding("the", true);
  assert.equal(page.key(3, 3, "the" + NBSP, "insertText", " "), true);
  assert.equal(page.key(4, 4, "the x", "insertText", "x"), true);
  assert.deepEqual(page.replaced, [[[3, 3, " "]], [[4, 4, "x"]]]);
  assert.deepEqual([page.committed, page.painted(), page.reports], [["the ", "the x"], "the x", []]);
});

test("rule 55: a typed U+00A0 is committed as U+00A0 and keeps that form when the browser later shows a space", () => {
  const page = fieldBinding("the", true);
  assert.equal(page.key(3, 3, "the" + NBSP, "insertText", NBSP), true);
  assert.equal(page.key(4, 4, "the x", "insertText", "x"), true);
  assert.deepEqual(page.replaced, [[[3, 3, NBSP]], [[4, 4, "x"]]]);
  assert.deepEqual([page.committed, page.painted(), page.reports], [["the" + NBSP, "the" + NBSP + "x"], "the" + NBSP + "x", []]);
});

test("rule 55 does not widen native evidence: a letter changed beside the target is still refused with foldSpaceForm", () => {
  const page = fieldBinding("the t", true);
  assert.equal(page.key(4, 5, "thX" + NBSP, "deleteContentBackward", null), true);
  assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-native-evidence" }]);
  assert.deepEqual([page.committed, page.painted()], [[], "the t"]);
});

test("rule 55: an input without a target adopts only the deletion, not the space form the browser changed", () => {
  const page = fieldBinding("the t", true);
  assert.equal(page.adopt("the" + NBSP), true);
  assert.deepEqual([page.replaced, page.committed, page.painted(), page.reports], [[[[4, 5, ""]]], ["the "], "the ", []]);
});

test("rule 55: a field whose only difference is the space form is neither adopted nor reset", () => {
  const page = fieldBinding("the ", true);
  assert.equal(page.adopt("the" + NBSP), true);
  assert.deepEqual([page.replaced, page.field.shown, page.reports], [[], "the" + NBSP, []]);
});
