import test from "node:test";
import assert from "node:assert/strict";
import { jsdomWindow } from "../editing/jsdom.mjs";
import { startProductionTags, registerProductionTag, scheduleProductionRefresh, scheduleUntaggedScan, tagsInField, onTagged, announceTagged, openTagComposer } from "../../../src/features/tags/production-tags.ts";
import type { ProductionTagPorts } from "../../../src/features/tags/ports.ts";
import { fakeDocument, fakeEdits, fakeNotices } from "../fakes.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { createProductionIndex } from "../../../src/application/production/production-index.ts";
import { deepFreeze } from "../../../src/core/document/freeze.ts";
import { createEffectScheduler } from "../../../src/application/session/effects.ts";
import { fakeClock } from "../../application/session-fakes.ts";
import { migrateRows } from "../../../src/core/migrate.ts";

const win = jsdomWindow() as unknown as Window & typeof globalThis;
const realm = globalThis as unknown as Record<string, unknown>;
realm.window = win;
realm.document = win.document;
realm.CSS = win.CSS;
realm.NodeFilter = win.NodeFilter;

function fixture() {
  const migration = fakeMigration();
  const reader = fakeDocument(null);
  const edits = fakeEdits();
  const jobs: string[] = [];
  const index = createProductionIndex(migration.ports.readers, deepFreeze);
  const notices = fakeNotices();
  const ports: ProductionTagPorts = {
    document: reader.document,
    edits: edits.edits,
    refresh: { request: (job) => { jobs.push(job); }, cancel: () => {} },
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
    notices: notices.notices,
    ids: migration.ids
  };
  return { ports, jobs, edits, migration, notices };
}

for (const selection of ["partial-end", "partial-start", "enclosing", "inside", "before", "after"] as const) {
  test("the Tag button checks the selected range for an existing tag: " + selection, () => {
    const h = fixture();
    document.body.innerHTML = '<div id="rows"><div class="row" data-id="r1"><div class="visual-cell">' +
      '<div class="cell-editable" data-id="r1" data-field="visualText" tabindex="0">rain on the ' +
      '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="umbrella" contenteditable="false">umbrella</span> roof</div></div></div></div>' +
      '<div id="tag-quote"></div><input id="tag-name"><div id="tag-cats"></div><div id="tag-name-list"></div>' +
      '<input id="tag-all" type="checkbox"><div id="tag-hint"></div><div id="tag-modal" hidden></div>';
    const cell = document.querySelector(".cell-editable") as HTMLElement;
    const tag = cell.querySelector(".tag-anchor") as HTMLElement;
    const range = document.createRange();
    if (selection === "partial-end") { range.setStart(cell.firstChild as Node, 0); range.setEnd(tag.firstChild as Node, 4); }
    if (selection === "partial-start") { range.setStart(tag.firstChild as Node, 3); range.setEnd(cell.lastChild as Node, 5); }
    if (selection === "enclosing") { range.selectNodeContents(cell); }
    if (selection === "inside") { range.selectNodeContents(tag); }
    if (selection === "before") { range.setStart(cell.firstChild as Node, 0); range.setEnd(cell.firstChild as Node, 11); }
    if (selection === "after") { range.setStart(cell.lastChild as Node, 0); range.setEnd(cell.lastChild as Node, 5); }
    cell.focus();
    const selected = win.getSelection() as Selection;
    selected.removeAllRanges();
    selected.addRange(range);
    const before = cell.innerHTML;
    const quote = selected.toString();
    const mounted = startProductionTags(h.ports);
    try {
      openTagComposer({ rowId: "r1", field: "visualText", quotedText: quote, occurrenceIndex: 0 });
      const refused = selection !== "before" && selection !== "after";
      assert.equal(document.getElementById("tag-modal")?.hidden, refused);
      assert.equal(cell.innerHTML, before);
      assert.equal(selected.toString(), quote);
      assert.equal(h.edits.ran.length, 0);
      assert.deepEqual(h.notices.shown.map(({ message, kind }) => ({ message, kind })), refused ? [
        { message: "That selection includes an existing tag. Select only untagged words.", kind: "warn" }
      ] : []);
    } finally {
      mounted.dispose();
      selected.removeAllRanges();
    }
  });
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
  const retained = (win as unknown as Record<string, unknown>).__cacheTest as {
    index: () => unknown; frozen: () => unknown[]; writes: () => unknown[];
  };
  let heard = 0;
  const listener = () => { heard++; };
  const oldOff = onTagged(listener);
  openTagComposer({ quotedText: "Kettle" });
  assert.equal(document.getElementById("tag-modal")?.hidden, false);
  first.dispose();
  assert.equal(document.getElementById("tag-modal")?.hidden, true);
  const second = startProductionTags(h.ports);
  try {
    first.dispose();
    assert.equal(retained.index(), null);
    assert.deepEqual(retained.frozen(), []);
    assert.deepEqual(retained.writes(), []);
    announceTagged();
    assert.equal(heard, 0);
    const off = second.onTagged(listener);
    oldOff();
    announceTagged();
    assert.equal(heard, 1);
    off();
    assert.equal(document.querySelectorAll("#tag-icon-style").length, 1);
    assert.equal(document.getElementById("tag-modal")?.hidden, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.notEqual(document.activeElement?.id, "tag-name");
  } finally {
    second.dispose();
  }
});

test("a retained composer focus callback is inert after disposal and remount", () => {
  const h = fixture();
  document.body.innerHTML = '<div id="tag-quote"></div><input id="tag-name"><div id="tag-cats"></div>' +
    '<div id="tag-name-list"></div><input id="tag-all" type="checkbox"><div id="tag-hint"></div><div id="tag-modal" hidden></div>';
  const originalSet = realm.setTimeout;
  const originalClear = realm.clearTimeout;
  const held: (() => void)[] = [];
  const cleared: unknown[] = [];
  realm.setTimeout = (run: () => void) => { held.push(run); return held.length; };
  realm.clearTimeout = (id: unknown) => { cleared.push(id); };
  let current = startProductionTags(h.ports);
  try {
    openTagComposer({ quotedText: "Hat" });
    openTagComposer({ quotedText: "Hat" });
    current.dispose();
    assert.deepEqual(cleared, [1, 2]);
    current = startProductionTags(h.ports);
    for (const run of held) run();
    assert.notEqual(document.activeElement?.id, "tag-name");
    assert.equal(document.getElementById("tag-modal")?.hidden, true);
  } finally {
    current.dispose();
    realm.setTimeout = originalSet;
    realm.clearTimeout = originalClear;
  }
});

test("a failed timer cancellation still clears injected ports, closes the composer and disconnects retained refresh", () => {
  const h = fixture();
  document.body.innerHTML = '<div id="tag-quote"></div><input id="tag-name"><div id="tag-cats"></div>' +
    '<div id="tag-name-list"></div><input id="tag-all" type="checkbox"><div id="tag-hint"></div><div id="tag-modal" hidden></div>';
  const failure = new Error("cancel failed");
  const mounted = startProductionTags({ ...h.ports, refresh: { ...h.ports.refresh, cancel: () => { throw failure; } } });
  openTagComposer({ quotedText: "Hat" });
  assert.throws(() => mounted.dispose(), (error) => error === failure);
  assert.equal(document.getElementById("tag-modal")?.hidden, true);
  assert.equal(document.getElementById("tag-icon-style"), null);
  assert.equal(tagsInField, null);
  assert.doesNotThrow(() => mounted.refresh(new Set(["untagged"])));
  assert.doesNotThrow(() => mounted.dispose());
});

for (const remount of [false, true]) {
  test("a real scheduled scan held across disposal cannot read ports or restore highlights" + (remount ? " after remount" : ""), () => {
    const highlights = new Map<string, Set<Range>>();
    const css = win.CSS as unknown as Record<string, unknown>;
    const oldHighlights = css.highlights;
    const oldHighlight = (win as unknown as Record<string, unknown>).Highlight;
    css.highlights = highlights;
    class TestHighlight extends Set<Range> {}
    (win as unknown as Record<string, unknown>).Highlight = TestHighlight;
    realm.Highlight = TestHighlight;
    document.body.innerHTML = '<div id="rows"><div class="visual-cell"><div class="cell-editable">Hat</div></div></div>';
    const h = fixture();
    const doc = migrateRows({ schema: 2, rows: [], productionTags: [{ id: "t_hat", cat: "prop", name: "Hat" }] }, h.migration.ports);
    const clock = fakeClock();
    const held: (() => void)[] = [];
    let current: ReturnType<typeof startProductionTags> | null = null;
    let reads = 0;
    let replacementReads = 0;
    const scheduler = createEffectScheduler({
      dirty: () => {}, draft: () => {}, save: () => {},
      refresh: (jobs) => { current?.refresh(jobs); }
    }, { ...clock, start: (run, ms) => { held.push(run); return clock.start(run, ms); } });
    const ports: ProductionTagPorts = {
      ...h.ports,
      document: { ...h.ports.document, current: () => { reads++; return doc; } },
      refresh: { request: scheduler.refresh, cancel: scheduler.cancelRefresh }
    };
    current = startProductionTags(ports);
    try {
      scheduleUntaggedScan();
      clock.advance(180);
      assert.equal(highlights.has("splitpage-untagged"), true);
      scheduleUntaggedScan();
      const retired = held[held.length - 1] as () => void;
      const first = current;
      current = null;
      first.dispose();
      const afterDispose = reads;
      assert.equal(tagsInField, null);
      assert.equal(highlights.has("splitpage-untagged"), false);
      assert.equal(clock.armed(), 0);
      if (remount) {
        current = startProductionTags({
          ...ports,
          document: { ...ports.document, current: () => { replacementReads++; return doc; } }
        });
      }
      first.refresh(new Set(["untagged"]));
      retired();
      clock.advance(1000);
      assert.equal(reads, afterDispose);
      assert.equal(replacementReads, 0);
      assert.equal(highlights.has("splitpage-untagged"), false);
      if (remount) {
        scheduleUntaggedScan();
        retired();
        assert.deepEqual(scheduler.pending(), ["untagged"]);
        assert.equal(replacementReads, 0);
        clock.advance(180);
        assert.ok(replacementReads > 0);
        assert.equal(highlights.has("splitpage-untagged"), true);
      }
    } finally {
      current?.dispose();
      scheduler.dispose();
      css.highlights = oldHighlights;
      (win as unknown as Record<string, unknown>).Highlight = oldHighlight;
      realm.Highlight = oldHighlight;
    }
  });
}
