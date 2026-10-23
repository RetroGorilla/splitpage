import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { fakeDocument, fakeNotices } from "../../../tests/features/fakes.ts";
import { fakeMigration } from "../../../tests/core/migrate-ports.ts";
import { migrateRows } from "../../core/migrate.ts";
import type { FindPorts } from "./ports.ts";
import { __init, findQueryChanged, replaceCurrent } from "./find.js";

test("find uses owner ports to reveal matches and refuses edits in review", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const realm = globalThis as unknown as Record<string, unknown>;
  realm.window = win;
  realm.document = win.document;
  realm.CSS = win.CSS;
  win.document.body.innerHTML = '<div id="findbar" hidden><input id="find-input" value="needle"><span id="find-count"></span></div><div id="find-tag-row" hidden></div><button id="find-tag"></button>';
  const doc = migrateRows({ rows: [{ id: "r1", visualText: "needle", audioText: "" }] }, fakeMigration().ports);
  const reader = fakeDocument(doc);
  const revealed: string[] = [];
  let open = false;
  let edits = 0;
  const ports: FindPorts = {
    document: reader.document,
    edits: { edit: () => { edits++; return true; }, stamps: { clock: { nowIso: () => "2026-10-23T00:00:00.000Z" }, editor: { name: () => "Test" } } },
    text: {
      cellOf: (html) => [{ text: String(html || ""), marks: {} }],
      inertBody: () => win.document.body,
      sanitizeHtml: (html) => String(html)
    },
    shotHiding: () => ({ reveal: (id) => { revealed.push(id); } }),
    review: { refuseInReview: () => true },
    undo: { breakCoalescing: () => {} },
    notices: fakeNotices().notices,
    flags: { setFindOpen: (value) => { open = value; } }
  };
  const mounted = __init(ports);
  mounted.openFindBar();
  assert.equal(open, true);
  assert.deepEqual(revealed, [doc.rows[0]?.id]);
  assert.equal(win.document.getElementById("find-count")?.textContent, "1 of 1");
  replaceCurrent();
  assert.equal(edits, 0);
  mounted.dispose();
  mounted.dispose();
  assert.equal(open, false);
  const again = __init(ports);
  findQueryChanged();
  assert.equal(win.document.getElementById("find-count")?.textContent, "1 of 1");
  again.dispose();
  win.close();
});
