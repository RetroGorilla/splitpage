import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../../../tests/features/editing/jsdom.mjs";
import { fakeDocument, fakeNotices, fakeFindPresent, fakeSharedCommands } from "../../../tests/features/fakes.ts";
import { fakeMigration } from "../../../tests/core/migrate-ports.ts";
import { migrateRows } from "../../core/migrate.ts";
import type { FindPorts } from "./ports.ts";
import { startFind, findQueryChanged, runBulkTag, replaceAll } from "./find.ts";
import { sharedCommandGuard } from "../../bootstrap/wiring/ports/shared-command-notices.ts";
import { replicas } from "../../../tests/adapters/collab/executor-support.ts";
import { adapterReplica, sharedHarness } from "../../../tests/application/session/shared-session-support.ts";
import { encodeSharedState } from "../../adapters/collab/document.ts";

test("rules 73 and 88: Find bulk tagging and Split replace-all refuse once before standalone work", () => {
  const win = jsdomWindow() as unknown as Window & typeof globalThis;
  const realm = globalThis as unknown as Record<string, unknown>;
  realm.window = win; realm.document = win.document; realm.CSS = win.CSS;
  win.document.body.innerHTML = '<input id="find-input" value="Cup"><input id="replace-input" value="Mug">';
  const set = replicas();
  const shared = sharedHarness(adapterReplica(set.a));
  const notices = fakeNotices();
  const fail = () => { assert.fail("bulk tagging reached standalone work"); };
  const mounted = startFind({
    sharedCommands: sharedCommandGuard(() => shared.session.read(doc => doc !== null), notices.notices),
    document: { current: () => shared.session.read(doc => doc), read: shared.session.read, onChange: shared.session.subscribe },
    edits: { edit: fail, stamps: { clock: { nowIso: () => "now" }, editor: { name: () => "Editor" } } },
    text: { cellOf: () => [], inertBody: () => win.document.body, sanitizeHtml: String },
    shotHiding: () => ({ reveal: fail }), undo: { breakCoalescing: fail }, notices: notices.notices,
    flags: { setFindOpen: () => {} }, options: { matchesCase: () => false }, bulkTag: fail, present: fakeFindPresent().present
  });
  try {
    for (const run of [runBulkTag, replaceAll]) {
      notices.shown.length = 0;
      const before = encodeSharedState(set.a);
      run();
      assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["This is not available in a shared session yet.", "warn"]]);
      assert.deepEqual(encodeSharedState(set.a), before);
      assert.deepEqual(shared.undo, []);
    }
  } finally { mounted.dispose(); shared.session.dispose(); set.close(); win.close(); }
});

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
  const presentation = fakeFindPresent();
  let open = false;
  const ports: FindPorts = {
    sharedCommands: fakeSharedCommands(),
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
    present: presentation.present
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
  const content = win.document.createElement("div");
  content.id = "prompter-content";
  content.innerHTML = '<div class="prompter-line">needle</div>';
  win.document.body.append(content);
  presentation.state.open = true;
  const presenting = startFind(ports);
  presenting.openFindBar();
  assert.equal(presentation.state.searching, true);
  win.document.getElementById("findbar")?.remove();
  presenting.dispose();
  assert.equal(presentation.state.searching, false);
  presentation.changed();
  win.close();
});
