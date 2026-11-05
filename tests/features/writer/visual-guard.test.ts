import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startWriter } from "../../../src/features/writer/writer.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeWriterPorts } from "../fakes.ts";

test("the floating visual editor shares the writer's viewing-only input guard", () => {
  document.documentElement.innerHTML = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");
  const h = fakeWriterPorts(migrateRows({ rows: [{ id: "a", audioText: "Alpha" }] }, fakeMigration().ports));
  h.state.allowed = false;
  const writer = startWriter(h.ports);
  const cell = document.createElement("div");
  cell.className = "wr-flow-visual-text cell-editable";
  cell.contentEditable = "true";
  document.getElementById("writer")?.appendChild(cell);
  try {
    for (const event of [
      new window.InputEvent("beforeinput", { inputType: "insertText", data: "x", bubbles: true, cancelable: true }),
      new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      new window.Event("paste", { bubbles: true, cancelable: true })
    ]) {
      cell.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, event.type);
    }
  } finally { writer.dispose(); }
});
