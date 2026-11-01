import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../../src/core/migrate.ts";
import type { TargetPorts } from "../../../src/features/rundown/ports.ts";
import { startTarget as mountOverlay, paintTargetOverlay } from "../../../src/features/rundown/target.ts";
import { startTargetSection as mountTarget } from "../../../src/features/title/target-section.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeDocument, fakeEdits, fakeNotices } from "../fakes.ts";

function setup(targetSeconds: number | null = null) {
  document.body.innerHTML = '<div id="rundown-overlay"></div><div id="popover"></div>';
  const doc = migrateRows({ title: "Target", targetSeconds, rows: [{ id: "r1", visualText: "", audioText: "" }] }, fakeMigration().ports);
  const edits = fakeEdits();
  const notices = fakeNotices();
  const ports: TargetPorts = {
    document: fakeDocument(doc).document,
    edits: edits.edits,
    notices: notices.notices
  };
  const overlay = mountOverlay(ports);
  const section = mountTarget(ports);
  return { edits, notices, owner: { ...section, dispose: () => { section.dispose(); overlay.dispose(); } } };
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

test("target: dispose empties the section and the overlay stops painting", () => {
  const { owner } = setup(60);
  owner.dispose();
  assert.equal(owner.section.html(), "");
  paintTargetOverlay();
  assert.equal(document.getElementById("rundown-overlay")?.innerHTML, "");
});
