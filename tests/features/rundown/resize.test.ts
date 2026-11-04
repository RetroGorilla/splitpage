import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { productionReaders } from "../../../src/bootstrap/document-ports.ts";
import { cellOf } from "../../../src/bootstrap/richtext.ts";
import { paintTargetOverlay, startTarget } from "../../../src/features/rundown/target.ts";
import { renderRundown, startRundown } from "../../../src/features/rundown/rundown.ts";
import type { RundownPorts } from "../../../src/features/rundown/ports.ts";
import { fakeActions, fakeDocument, fakeEdits, fakeNotices, fakePreferenceChanges } from "../fakes.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

Object.assign(globalThis, { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });

const SENTENCE ="The harbour was quiet when the first boat came in, and nobody on the quay said a word about it.";

function script(status: string, target?: number): ValidatedDocument {
  return migrateRows({
    title: "Resize",
    targetSeconds: target,
    rows: [
      { id: "a", audioText: SENTENCE, status },
      { id: "b", audioText: SENTENCE + " " + SENTENCE },
      { id: "c", audioText: SENTENCE }
    ]
  }, fakeMigration().ports);
}

function setup(doc: ValidatedDocument) {
  document.body.innerHTML = '<div id="rundown"><div class="rundown-sections"></div><div class="rundown-ruler"></div>' +
    '<div class="rundown-track"><div class="rundown-blocks"></div><div id="rundown-overlay" class="rundown-overlay"></div><div class="rundown-playhead"></div></div></div>';
  const track = document.querySelector<HTMLElement>(".rundown-track") as HTMLElement;
  let width = 800;
  Object.defineProperty(track, "clientWidth", { configurable: true, get: () => width });
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
  const resize = (next: number): void => { width = next; renderRundown(); };
  return { source, owner, target, resize };
}

const blocks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".rd-block")];
const marks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".rundown-ruler > *")];

test("rundown resize: narrowing the strip moves the beat blocks and ruler marks it already has", () => {
  const { owner, target, resize } = setup(script("todo"));
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
  target.dispose();
  owner.dispose();
});

test("rundown resize: a block keeps focus while the strip is resized", () => {
  const { owner, target, resize } = setup(script("todo"));
  resize(800);
  const second = blocks()[1] as HTMLElement;
  second.focus();
  assert.equal(document.activeElement, second);
  resize(780);
  assert.equal(document.activeElement, second);
  target.dispose();
  owner.dispose();
});

test("rundown resize: a change to what a block says still rebuilds it", () => {
  const { source, owner, target, resize } = setup(script("todo"));
  resize(800);
  const before = blocks();
  assert.ok(!before[0]?.classList.contains("is-shot"));
  source.replace(script("shot"));
  resize(790);
  const after = blocks();
  assert.equal(after.length, before.length);
  assert.notEqual(after[0], before[0]);
  assert.ok(after[0]?.classList.contains("is-shot"));
  target.dispose();
  owner.dispose();
});

test("rundown resize: the target line follows the strip without being rebuilt", () => {
  const { owner, target, resize } = setup(script("todo", 30));
  resize(800);
  paintTargetOverlay();
  const line = document.querySelector<HTMLElement>(".rd-target-line");
  const label = document.querySelector<HTMLElement>(".rd-target-label");
  assert.ok(line && label);
  const at = line.style.left;
  resize(700);
  paintTargetOverlay();
  assert.equal(document.querySelector(".rd-target-line"), line);
  assert.equal(document.querySelector(".rd-target-label"), label);
  assert.notEqual(line.style.left, at);
  target.dispose();
  owner.dispose();
});
