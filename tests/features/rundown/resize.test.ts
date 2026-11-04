import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { productionReaders } from "../../../src/bootstrap/document-ports.ts";
import { cellOf } from "../../../src/bootstrap/richtext.ts";
import { paintTargetOverlay, startTarget, targetOverlayParts } from "../../../src/features/rundown/target.ts";
import { renderRundown, rundownLayout, rundownTicks, startRundown } from "../../../src/features/rundown/rundown.ts";
import type { RundownPorts } from "../../../src/features/rundown/ports.ts";
import { fakeActions, fakeDocument, fakeEdits, fakeNotices, fakePreferenceChanges } from "../fakes.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

Object.assign(globalThis, { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });

const SENTENCE = "The harbour was quiet when the first boat came in, and nobody on the quay said a word about it.";
const LABEL_PX = 60;
const WIDTHS = [900, 800, 700, 640, 520, 400, 300, 200, 400, 800];

function script(status: string, target?: number, repeat = 1): ValidatedDocument {
  const long = Array.from({ length: repeat }, () => SENTENCE).join(" ");
  return migrateRows({
    title: "Resize",
    targetSeconds: target,
    sections: [{ id: "s1", name: "Open", firstSceneId: "a" }, { id: "s2", name: "Harbour", firstSceneId: "c" }],
    rows: [
      { id: "a", audioText: long, status },
      { id: "b", audioText: long + " " + SENTENCE },
      { id: "c", audioText: long }
    ]
  }, fakeMigration().ports);
}

function setup(t: TestContext, doc: ValidatedDocument, labelShown = true) {
  document.body.innerHTML = '<div id="rundown"><div class="rundown-sections"></div><div class="rundown-ruler"></div>' +
    '<div class="rundown-track"><div class="rundown-blocks"></div><div id="rundown-overlay" class="rundown-overlay"></div><div class="rundown-playhead"></div></div></div>';
  const track = document.querySelector<HTMLElement>(".rundown-track") as HTMLElement;
  let width = 800;
  Object.defineProperty(track, "clientWidth", { configurable: true, get: () => width });
  const held = { labelShown };
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains("rd-target-label") && held.labelShown ? LABEL_PX : 0; }
  });
  t.after(() => { if (original) Object.defineProperty(HTMLElement.prototype, "offsetWidth", original); else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth"); });
  const source = fakeDocument(doc);
  const ports: RundownPorts = {
    document: source.document,
    text: { cellOf, productionReaders, cacheSeal: ((value: unknown) => value) as RundownPorts["text"]["cacheSeal"] },
    rowDrag: { dragging: () => null, end: () => {} },
    cells: { moveRow: () => {} },
    actions: fakeActions().actions,
    minimized: { rundownMin: () => false, setRundownMin: () => {} },
    changes: fakePreferenceChanges().changes
  };
  const owner = startRundown(ports);
  const target = startTarget({ document: source.document, edits: fakeEdits().edits, notices: fakeNotices().notices });
  t.after(() => { target.dispose(); owner.dispose(); });
  const resize = (next: number): void => { width = next; renderRundown(); paintTargetOverlay(); };
  width = 333;
  renderRundown();
  const rebuild = (fresh: ValidatedDocument, other: ValidatedDocument): void => {
    source.replace(other);
    renderRundown();
    source.replace(fresh);
    renderRundown();
  };
  return { source, held, resize, rebuild };
}

const blocks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".rd-block")];
const marks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".rundown-ruler > *")];
const boxes = (els: readonly HTMLElement[]): string[] => els.map((el) => el.style.left + " " + el.style.width + " " + el.textContent);
const px = (el: HTMLElement | undefined, side: "left" | "width"): number => parseFloat(el?.style[side] ?? "NaN");

function expectedMarks(): string[] {
  const view = rundownLayout();
  return rundownTicks(view.spanSeconds, view.pxPerSecond, view.width, view.x).flatMap((tick) => [
    (tick.major ? "rd-tick is-major" : "rd-tick") + " " + tick.x + "px ",
    ...(tick.label ? ["rd-label " + (tick.x + 4) + "px " + tick.label] : [])
  ]);
}

const actualMarks = (): string[] => marks().map((el) => el.className + " " + el.style.left + " " + el.textContent);

test("rundown resize: blocks, scene labels and ruler marks are where a fresh build puts them at every width", (t) => {
  const { resize, rebuild } = setup(t, script("todo", undefined, 8));
  const tickCounts = new Set<number>();
  const labelCounts = new Set<number>();
  for (const width of WIDTHS) {
    resize(width);
    const movedBlocks = boxes(blocks());
    const movedSections = boxes([...document.querySelectorAll<HTMLElement>(".rd-section")]);
    const movedMarks = actualMarks();
    assert.equal(movedBlocks.length, 3);
    assert.deepEqual(movedMarks, expectedMarks());
    tickCounts.add(marks().filter((el) => el.classList.contains("rd-tick")).length);
    labelCounts.add(marks().filter((el) => el.classList.contains("rd-label")).length);
    const all = blocks();
    all.forEach((block, i) => {
      assert.ok(px(block, "width") > 0);
      const next = all[i + 1];
      if (next) assert.ok(Math.abs(px(next, "left") - px(block, "left") - px(block, "width") - 2) < 0.2);
    });
    const sections = [...document.querySelectorAll<HTMLElement>(".rd-section")];
    assert.equal(sections.length, 2);
    const span = (from: number, to: number): { left: number; width: number } => {
      const a = all[from] as HTMLElement;
      const b = all[to] as HTMLElement;
      return { left: px(a, "left"), width: Math.round((px(b, "left") + px(b, "width") - px(a, "left")) * 10) / 10 };
    };
    [span(0, 1), span(2, 2)].forEach((want, i) => {
      assert.equal(px(sections[i], "left"), want.left);
      assert.equal(Math.round(px(sections[i], "width") * 10) / 10, want.width);
    });
    rebuild(script("todo", undefined, 8), script("shot", undefined, 8));
    assert.deepEqual(boxes(blocks()), movedBlocks);
    assert.deepEqual(boxes([...document.querySelectorAll<HTMLElement>(".rd-section")]), movedSections);
  }
  assert.ok(tickCounts.size > 1, "the sweep crosses a tick threshold " + JSON.stringify([...tickCounts]));
  assert.ok(labelCounts.size > 1, "the sweep crosses a label threshold " + JSON.stringify([...labelCounts]));
});

test("rundown resize: narrowing the strip moves the beat blocks and ruler marks it already has", (t) => {
  const { resize } = setup(t, script("todo"));
  resize(800);
  const first = blocks();
  const firstMarks = marks();
  const lefts = first.map((block) => block.style.left);
  assert.equal(first.length, 3);
  assert.ok(firstMarks.length > 0);
  resize(790);
  const second = blocks();
  const secondMarks = marks();
  assert.equal(second.length, first.length);
  second.forEach((block, i) => assert.equal(block, first[i]));
  assert.equal(secondMarks.length, firstMarks.length);
  secondMarks.forEach((mark, i) => assert.equal(mark, firstMarks[i]));
  assert.notDeepEqual(second.map((block) => block.style.left), lefts);
});

test("rundown resize: a block keeps focus while the strip is resized", (t) => {
  const { resize } = setup(t, script("todo"));
  resize(800);
  const second = blocks()[1] as HTMLElement;
  second.focus();
  assert.equal(document.activeElement, second);
  resize(780);
  assert.equal(document.activeElement, second);
});

test("rundown resize: a change to what a block says still rebuilds it", (t) => {
  const { source, resize } = setup(t, script("todo"));
  resize(800);
  const before = blocks();
  assert.ok(!before[0]?.classList.contains("is-shot"));
  source.replace(script("shot"));
  resize(790);
  const after = blocks();
  assert.equal(after.length, before.length);
  assert.notEqual(after[0], before[0]);
  assert.ok(after[0]?.classList.contains("is-shot"));
});

test("rundown resize: the target line follows the strip to where its layout puts it, without being rebuilt", (t) => {
  const { resize } = setup(t, script("todo", 30, 3));
  resize(800);
  const line = document.querySelector<HTMLElement>(".rd-target-line");
  const label = document.querySelector<HTMLElement>(".rd-target-label");
  assert.ok(line && label);
  for (const width of [700, 520, 400, 600]) {
    resize(width);
    const view = rundownLayout();
    const parts = targetOverlayParts(view.totalSeconds, 30, view.x);
    assert.ok(parts);
    assert.equal(document.querySelector(".rd-target-line"), line);
    assert.equal(document.querySelector(".rd-target-label"), label);
    assert.equal(line.style.left, parts.lineX + "px");
    assert.equal(label.style.left, parts.lineX + "px");
    const hatch = document.querySelector<HTMLElement>(".rd-target-hatch");
    if (parts.hatch) {
      assert.equal(hatch?.style.left, parts.hatch.left + "px");
      assert.equal(hatch?.style.width, parts.hatch.width + "px");
    }
    assert.equal(label.classList.contains("is-right"), parts.lineX < LABEL_PX + 4);
  }
});

test("rundown resize: a target label first built while the strip is hidden is measured again once it is shown", (t) => {
  const { held, resize } = setup(t, script("todo", 2, 6), false);
  resize(800);
  const line = document.querySelector<HTMLElement>(".rd-target-line");
  const label = document.querySelector<HTMLElement>(".rd-target-label");
  assert.ok(line && label);
  held.labelShown = true;
  resize(700);
  assert.equal(document.querySelector(".rd-target-label"), label);
  assert.ok(parseFloat(label.style.left) < LABEL_PX + 4, "the target sits closer to the start than the label is wide " + label.style.left + " " + label.className + " hatch=" + String(!!document.querySelector(".rd-target-hatch")) + " total=" + rundownLayout().totalSeconds);
  assert.equal(label.classList.contains("is-right"), true);
});
