import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { TargetPorts } from "../../../src/features/rundown/ports.ts";
import { __init as mountTarget, paintTargetOverlay, setTargetLength } from "../../../src/features/rundown/target.js";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices, fakeReview } from "../fakes.ts";

function setup(targetSeconds: number | null = null) {
  document.body.innerHTML = '<div id="rundown-overlay"></div><div id="popover"></div>';
  const doc = migrateRows({ title: "Target", targetSeconds, rows: [{ id: "r1", visualText: "", audioText: "" }] }, fakeMigration().ports);
  const edits = fakeEdits();
  const review = fakeReview();
  const notices = fakeNotices();
  const ports: TargetPorts = {
    document: fakeDocument(doc).document,
    edits: edits.edits,
    review: review.review,
    notices: notices.notices
  };
  return { edits, review, notices, owner: mountTarget(ports) };
}

function popover(html: string): HTMLElement {
  const wrap = document.getElementById("popover") as HTMLElement;
  wrap.innerHTML = html;
  return wrap;
}

test("target: the section reads the target through the document port and a preset runs one edit", () => {
  const { edits, owner } = setup(120);
  const wrap = popover(owner.section.html());
  assert.equal((wrap.querySelector("#target-input") as HTMLInputElement).value, "2:00");
  assert.equal(wrap.querySelector('[data-target-seconds="120"]')?.getAttribute("aria-pressed"), "true");
  let closed = 0;
  owner.section.wire(wrap, () => { closed++; });
  (wrap.querySelector('[data-target-seconds="60"]') as HTMLElement).click();
  assert.deepEqual(edits.ran.map((c) => c.name), ["set-target-length"]);
  assert.equal(closed, 1);
  owner.dispose();
});

test("target: an unreadable length shows an error notice and runs nothing", () => {
  const { edits, notices, owner } = setup();
  const wrap = popover(owner.section.html());
  owner.section.wire(wrap, () => {});
  const input = wrap.querySelector("#target-input") as HTMLInputElement;
  input.value = "soon";
  (wrap.querySelector("#target-save") as HTMLElement).click();
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.deepEqual(notices.shown.map((n) => n.kind), ["error"]);
  assert.deepEqual(edits.ran, []);
  owner.dispose();
});

test("target: in review the section is disabled and setting the target is refused", () => {
  const { edits, review, owner } = setup(60);
  review.setReviewing(true);
  const wrap = popover(owner.section.html());
  assert.ok((wrap.querySelector("#target-input") as HTMLInputElement).disabled);
  assert.match(wrap.textContent ?? "", /Viewing only/);
  assert.equal(setTargetLength(30), false);
  assert.deepEqual(edits.ran, []);
  owner.dispose();
});

test("target: dispose empties the section and the overlay stops painting", () => {
  const { owner } = setup(60);
  owner.dispose();
  assert.equal(owner.section.html(), "");
  paintTargetOverlay();
  assert.equal(document.getElementById("rundown-overlay")?.innerHTML, "");
});
