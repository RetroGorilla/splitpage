import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startProductionTags, registerProductionTag, scheduleProductionRefresh, scheduleUntaggedScan, tagsInField, onTagged, announceTagged, openTagComposer } from "../../../src/features/tags/production-tags.js";
import type { ProductionTagPorts } from "../../../src/features/tags/ports.ts";
import { fakeDocument, fakeEdits, fakeNotices } from "../fakes.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { createProductionIndex } from "../../../src/application/production/production-index.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
realm.CSS = win.CSS;

function fixture() {
  const migration = fakeMigration();
  const reader = fakeDocument(null);
  const edits = fakeEdits();
  const jobs: string[] = [];
  const index = createProductionIndex(migration.ports.readers, deepFreeze);
  const ports: ProductionTagPorts = {
    document: reader.document,
    edits: edits.edits,
    refresh: { request: (job) => { jobs.push(job); } },
    stamping: { stamp: () => { throw new Error("No stamp expected"); } },
    text: {
      cellOf: () => [], productionReaders: migration.ports.readers,
      inertBody: () => win.document.body, sanitizeHtml: (html) => String(html ?? "")
    },
    production: () => index,
    editing: {
      cells: () => ({ edit: () => null, sync: () => null }),
      focus: () => ({ promptMutedFor: () => null })
    },
    undo: { breakCoalescing: () => { throw new Error("No undo break expected"); } },
    view: () => ({ writerOpen: () => false }),
    notices: fakeNotices().notices,
    ids: migration.ids
  };
  return { ports, jobs, edits };
}

test("production tags mount with fake ports and keep reader identity, edit commands and refresh jobs", () => {
  const h = fixture();
  const mounted = startProductionTags(h.ports);
  try {
    assert.equal(document.querySelectorAll("#tag-icon-style").length, 1);
    assert.equal(tagsInField, h.ports.text.productionReaders.tagsInField);
    scheduleProductionRefresh();
    scheduleUntaggedScan();
    assert.deepEqual(h.jobs, ["production", "untagged"]);
    registerProductionTag("prop", "Kettle");
    assert.equal(h.edits.ran.length, 1);
    assert.equal(h.edits.ran[0]?.name, "register-tag");
    let heard = 0;
    const off = mounted.onTagged(() => { heard++; });
    announceTagged();
    off();
    announceTagged();
    assert.equal(heard, 1);
  } finally {
    mounted.dispose();
  }
  assert.equal(document.getElementById("tag-icon-style"), null);
});

test("disposal cancels composer focus and removes listeners before a fresh mount", async () => {
  const h = fixture();
  document.body.innerHTML = '<div id="tag-quote"></div><input id="tag-name"><div id="tag-cats"></div>' +
    '<div id="tag-name-list"></div><input id="tag-all" type="checkbox"><div id="tag-hint"></div><div id="tag-modal" hidden></div>';
  const first = startProductionTags(h.ports);
  let heard = 0;
  onTagged(() => { heard++; });
  openTagComposer({ quotedText: "Kettle" });
  first.dispose();
  const second = startProductionTags(h.ports);
  try {
    first.dispose();
    announceTagged();
    assert.equal(heard, 0);
    assert.equal(document.querySelectorAll("#tag-icon-style").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.notEqual(document.activeElement?.id, "tag-name");
  } finally {
    second.dispose();
  }
});
