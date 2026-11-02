import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { fakeDocument, fakeNotices, fakeFindPresent } from "../../../tests/features/fakes.ts";
import { fakeMigration } from "../../../tests/core/migrate-ports.ts";
import { migrateRows } from "../../core/migrate.ts";
import type { FindPorts } from "./ports.ts";
import { startFind, findQueryChanged } from "./find.ts";

test("find uses owner ports to reveal matches", () => {
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
  const ports: FindPorts = {
    document: reader.document,
    edits: { edit: () => true, stamps: { clock: { nowIso: () => "2026-10-23T00:00:00.000Z" }, editor: { name: () => "Test" } } },
    text: {
      cellOf: (html) => [{ text: String(html || ""), marks: {} }],
      inertBody: () => win.document.body,
      sanitizeHtml: (html) => String(html)
    },
    shotHiding: () => ({ reveal: (id) => { revealed.push(id); } }),
    undo: { breakCoalescing: () => {} },
    notices: fakeNotices().notices,
    flags: { setFindOpen: (value) => { open = value; } },
    options: { matchesCase: () => false },
    bulkTag: () => ({ hits: 0, inTags: 0, skipped: 0 }),
    present: fakeFindPresent().present
  };
  const mounted = startFind(ports);
  mounted.openFindBar();
  assert.equal(open, true);
  assert.deepEqual(revealed, [doc.rows[0]?.id]);
  assert.equal(win.document.getElementById("find-count")?.textContent, "1 of 1");
  mounted.dispose();
  mounted.dispose();
  assert.equal(open, false);
  const again = startFind(ports);
  findQueryChanged();
  assert.equal(win.document.getElementById("find-count")?.textContent, "1 of 1");
  again.dispose();
  win.close();
});
