import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountSceneControls } from "../../../src/features/rows/scene-controls.ts";
import { createSceneView } from "../../../src/application/editing/scene-view.ts";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import { scenesInOrder } from "../../../src/core/document/scenes.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { edgeInput } from "../edge-input.ts";
import { fakeNotices } from "../fakes.ts";

function sceneNamePage() {
  const { session, log } = harness();
  session.adopt({ rows: [{ id: "R1" }], sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }] });
  const name = () => session.read(doc => doc ? scenesInOrder(doc)?.[0]?.name : undefined);
  document.body.innerHTML = '<div id="rows"></div><button id="away">Away</button>';
  const container = document.getElementById("rows");
  assert.ok(container);
  const rows: HTMLElement = container;
  function paint() {
    rows.innerHTML = '<header class="section-header" data-section-id="H1">' +
      '<span role="heading"><button class="section-name"></button></span>' +
      '<button data-section-action="rename">Rename</button></header>';
    const heading = rows.querySelector<HTMLButtonElement>(".section-name");
    assert.ok(heading);
    heading.textContent = name() ?? "";
    return heading;
  }
  const firstHeading = paint();
  const commands: string[] = [];
  const controls = mountSceneControls(window, {
    document: { current: () => session.read(doc => doc), numbering: () => session.read(doc => deriveDocumentNumbering(doc ?? { rows: [] })) },
    edits: {
      allowed: () => true,
      run(command) {
        commands.push(command.name);
        const outcome = runConfined(session, command);
        if (outcome.kind === "applied" || outcome.kind === "committed") paint();
        return outcome;
      }
    },
    scenes: createSceneView(),
    focus: { focusedRow: () => {} },
    drag: { dragging: () => null, end: () => {} },
    ids: { id: () => "created" },
    notices: fakeNotices().notices,
    scroll: () => {},
    stopScroll: () => {}
  });
  const input = () => {
    const field = rows.querySelector<HTMLInputElement>(".section-rename input");
    assert.ok(field);
    return field;
  };
  const rename = rows.querySelector<HTMLButtonElement>('[data-section-action="rename"]');
  assert.ok(rename);
  rename.focus();
  rename.click();
  return {
    rows, firstHeading, paint, name, input, commands, log, edge: edgeInput(input),
    close() {
      controls.dispose();
      session.dispose();
      document.body.innerHTML = "";
    }
  };
}

test("Enter submits a scene rename once and focuses the heading after repaint", () => {
  const page = sceneNamePage();
  try {
    const input = page.input();
    assert.equal(document.activeElement, input);
    assert.equal(input.maxLength, 200);
    page.edge.type("N");
    page.edge.type("e");
    page.edge.type("w");
    assert.deepEqual([page.name(), page.commands], ["Scene", []]);
    page.edge.enter();
    const paintedHeading = page.rows.querySelector(".section-name");
    assert.deepEqual(page.commands, ["rename-section"]);
    assert.equal(page.log.filter(entry => entry === "undo.record").length, 1);
    assert.equal(page.name(), "New");
    assert.equal(paintedHeading?.textContent, "New");
    assert.equal(page.firstHeading.isConnected, false);
    assert.equal(input.isConnected, false);
    assert.equal(document.activeElement, paintedHeading);
  } finally { page.close(); }
});

test("replacing the scene header expires the focused rename and its draft", async () => {
  const page = sceneNamePage();
  try {
    const input = page.input(), form = input.form;
    assert.ok(form);
    page.edge.type("N");
    const replacement = page.paint();
    await Promise.resolve();
    replacement.parentElement?.append(form);
    form.requestSubmit();
    assert.deepEqual([page.name(), replacement.textContent, page.commands], ["Scene", "Scene", []]);
  } finally { page.close(); }
});
