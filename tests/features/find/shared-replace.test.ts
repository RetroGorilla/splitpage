import { test } from "node:test";
import assert from "node:assert/strict";
import { cellOf } from "../../../src/bootstrap/richtext.ts";
import { sharedRewritePorts } from "../../../src/bootstrap/wiring/ports/shared-rewrites.ts";
import { encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { operation } from "../../adapters/collab/executor-support.ts";
import { sharedCommand } from "../../application/session/shared-session-support.ts";
import { harness } from "../../application/session-fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { fakeNotices } from "../fakes.ts";
import {
  FIND_ORDERS as ORDERS, findSource as source, finder, findAct as act, findReplicas as setup, findCopy as copy, rowCells as cells, stampedCells as expected,
  agreedRows as agreeing, deliverAll as flush, sendAs as send, typedAt as typing, deletedAt as deleting, shownMessages as messages
} from "./shared-replace-support.ts";

const TOKEN = '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>';
const TAG = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Gaffer tape" contenteditable="false">gaffer tape</span>';
const CMT = (inner: string) => '<span class="cmt-anchor" data-cmt="C1">' + inner + "</span>";
const NOT_SHARED = "This is not available in a shared session yet.", CHANGED = "This line changed. Try replacing again.";

interface Fixture {
  readonly name: string;
  readonly cell: string;
  readonly find: string;
  readonly put: string;
  readonly all?: boolean;
  readonly nth?: number;
  readonly matchCase?: boolean;
  readonly visual?: boolean;
  readonly after: string;
  readonly shared: "same" | "refused";
}

const FIXTURES: readonly Fixture[] = [
  { name: "plain words", cell: "a cup of tea", find: "cup", put: "mug", after: "a mug of tea", shared: "same" },
  { name: "the second match", cell: "cup, cup", find: "cup", put: "mug", nth: 1, after: "cup, mug", shared: "same" },
  { name: "every match", cell: "cup, cup and cup", find: "cup", put: "mug", all: true, after: "mug, mug and mug", shared: "same" },
  { name: "adjacent matches", cell: "cupcup", find: "cup", put: "mug", all: true, after: "mugmug", shared: "same" },
  { name: "a bold match", cell: "a <strong>cup</strong> here", find: "cup", put: "mug", after: "a <strong>mug</strong> here", shared: "same" },
  { name: "a match that runs into bold", cell: "c<strong>up</strong>s", find: "cup", put: "mug", after: "mugs", shared: "same" },
  { name: "a match that starts in bold", cell: "<strong>cu</strong>p!", find: "cup", put: "mug", after: "<strong>mug</strong>!", shared: "same" },
  { name: "bold and plain matches", cell: "<strong>cup</strong> and cup", find: "cup", put: "mug", all: true, after: "<strong>mug</strong> and mug", shared: "same" },
  { name: "a linked match", cell: '<a href="https://e.x/">cup</a> now', find: "cup", put: "mug", after: '<a href="https://e.x/" target="_blank" rel="noopener">mug</a> now', shared: "same" },
  { name: "a match inside a comment", cell: "a " + CMT("cup"), find: "cup", put: "mug", after: "a " + CMT("mug"), shared: "same" },
  { name: "matches around a line break", cell: "cup<br>cup", find: "cup", put: "mug", all: true, after: "mug<br>mug", shared: "same" },
  { name: "a stage direction", cell: '<span class="stage-dir">cup</span> ok', find: "cup", put: "mug", after: '<span class="stage-dir">mug</span> ok', shared: "same" },
  { name: "words beside a tag", cell: TAG + " tape", find: "tape", put: "rope", all: true, after: TAG + " rope", shared: "same" },
  { name: "a B-roll key's words in narration", cell: TOKEN + " a cup", find: "cup", put: "mug", after: TOKEN + " a mug", shared: "refused" },
  { name: "narration before a B-roll key", cell: "a cup " + TOKEN + " drone", find: "cup", put: "mug", after: "a mug " + TOKEN + " drone", shared: "same" },
  { name: "a B-roll line's shot name", cell: TOKEN + " Cup", find: "Cup", put: "Mug", visual: true, after: TOKEN + " Mug", shared: "refused" },
  { name: "words after an @Name", cell: "@Ann reads cup", find: "cup", put: "mug", after: "@Ann reads mug", shared: "same" },
  { name: "a typed @Name", cell: "@Ann reads cup", find: "Ann", put: "Bob", after: "@Bob reads cup", shared: "same" },
  { name: "an empty replacement", cell: "a cup of", find: "cup", put: "", after: "a  of", shared: "same" },
  { name: "any case", cell: "Cup cup CUP", find: "cup", put: "mug", all: true, after: "mug mug mug", shared: "same" },
  { name: "matching case", cell: "Cup cup", find: "cup", put: "mug", all: true, matchCase: true, after: "Cup mug", shared: "same" },
  { name: "a visual cell", cell: "cup shot", find: "cup", put: "mug", visual: true, after: "mug shot", shared: "same" },
  { name: "beside emoji", cell: "\u{1F600}cup\u{1F600}", find: "cup", put: "mug", after: "\u{1F600}mug\u{1F600}", shared: "same" },
  { name: "a replacement holding the words", cell: "cup cup", find: "cup", put: "cupcup", all: true, after: "cupcup cupcup", shared: "same" },
  { name: "markup characters in the replacement", cell: "a cup of", find: "cup", put: "<b>&", after: "a &lt;b&gt;&amp; of", shared: "same" }
];


for (const fixture of FIXTURES) test(`Find replace differential, standalone against shared: ${fixture.name}`, () => {
  const aloneNotices = fakeNotices(), h = harness();
  h.session.adopt(source(fixture.cell, fixture.visual));
  const alone = finder(h.session, aloneNotices, undefined, fixture.matchCase);
  try { act(alone, fixture); } finally { alone.dispose(); }
  const standalone = h.session.read(doc => doc?.rows.map(cells));
  assert.deepEqual(standalone?.[0], expected(fixture.after, fixture.visual));
  const sharedNotices = fakeNotices(), set = setup(source(fixture.cell, fixture.visual)), a = copy(set.a, "Alice", sharedNotices);
  try {
    const before = encodeSharedState(set.a);
    const route = finder(a.session, sharedNotices, a.shared, fixture.matchCase);
    try { act(route, fixture); } finally { route.dispose(); }
    flush(set.queue, "D1");
    if (fixture.shared === "refused") {
      assert.deepEqual(encodeSharedState(set.a), before);
      assert.deepEqual(messages(sharedNotices), [[NOT_SHARED, "warn"]]);
      assert.deepEqual(a.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
      return;
    }
    assert.deepEqual(agreeing(fixture.name, set), standalone);
    assert.deepEqual(messages(sharedNotices), messages(aloneNotices));
    assert.equal(a.harness.executed.length, 1);
    assert.deepEqual(a.owner.sizes(), { undo: 1, redo: 0, dropped: 0 });
  } finally { a.session.dispose(); set.close(); }
});

test("a shared Replace writes text operations on the matched characters only, then the beat's stamp", () => {
  const notices = fakeNotices(), set = setup(source("a <strong>cup</strong> of cup")), a = copy(set.a, "Alice", notices);
  try {
    const route = finder(a.session, notices, a.shared);
    try { route.search("cup", "mug"); route.replaceAll(); } finally { route.dispose(); }
    const operations = a.harness.executed[0]?.operations.map(value => ({ ...value })) as Record<string, unknown>[];
    const target = { owner: "R1", segment: "R1", field: "audioText" };
    assert.deepEqual(operations.slice(0, 4).map(value => ({ kind: value.kind, target: value.target, ...value.at ? { at: value.at } : {},
      ...value.content ? { content: value.content } : {}, ...value.observed ? { observed: value.observed } : {} })), [
      { kind: "text-insert", target, at: { left: null, right: flowBaseReference("R1", "audioText", 5), affinity: "before" },
        content: [{ value: "mug", marks: [{ kind: "b", value: true }] }] },
      { kind: "text-delete", target, observed: [flowBaseReference("R1", "audioText", 2, 5)] },
      { kind: "text-insert", target, at: { left: flowBaseReference("R1", "audioText", 8), right: null, affinity: "after" }, content: [{ value: "mug", marks: [] }] },
      { kind: "text-delete", target, observed: [flowBaseReference("R1", "audioText", 9, 12)] }
    ]);
    const owner = (value: Record<string, unknown>) => { const at = value.target as { owner?: string; record?: string }; return at.owner ?? at.record; };
    assert.deepEqual(operations.slice(4).map(value => [value.kind, owner(value)]), [["text-insert", "R2"], ["text-delete", "R2"], ["scalar", "R1"], ["scalar", "R2"]]);
  } finally { a.session.dispose(); set.close(); }
});

interface Race { readonly name: string; readonly cell: string; readonly all?: boolean; readonly at: number; readonly end?: boolean; readonly after: string }
const RACES: readonly Race[] = [
  { name: "typing before the match", cell: "a cup of tea", at: 0, after: "Xa mug of tea" },
  { name: "typing after the match", cell: "a cup of tea", at: 6, after: "a mug Xof tea" },
  { name: "typing at the end", cell: "a cup of tea", at: 11, end: true, after: "a mug of teaX" },
  { name: "typing just before the match", cell: "a cup of tea", at: 2, after: "a Xmug of tea" },
  { name: "typing inside the match", cell: "a cup of tea", at: 3, after: "a Xmug of tea" },
  { name: "typing just after the match", cell: "a cup of tea", at: 5, after: "a mugX of tea" },
  { name: "typing between two matches of Replace all", cell: "cup and cup", all: true, at: 5, after: "mug aXnd mug" },
  { name: "typing inside a match that ends the cell", cell: "cup and cup", all: true, at: 9, after: "mug and mugX" },
  { name: "typing beside a bold match", cell: "a <strong>cup</strong> here", at: 0, after: "Xa <strong>mug</strong> here" }
];

for (const race of RACES) for (const order of ORDERS) test(`a shared Replace keeps the other copy's typing in the same cell: ${race.name}, ${order}`, () => {
  const notices = fakeNotices(), set = setup(source(race.cell)), a = copy(set.a, "Alice", notices);
  try {
    const route = finder(a.session, notices, a.shared);
    try { act(route, { find: "cup", put: "mug", all: race.all }); } finally { route.dispose(); }
    send(set.b, typing(race.at, race.end));
    flush(set.queue, order);
    assert.deepEqual(agreeing(race.name, set, order)[0], expected(race.after));
  } finally { a.session.dispose(); set.close(); }
});

for (const order of ORDERS) {
  test(`rule 185: a Replace whose cell changed after the search is refused with its notice and writes nothing; the next Replace uses the new text: ${order}`, () => {
    const notices = fakeNotices(), set = setup(source("a cup of tea")), a = copy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try {
        route.search("cup", "mug");
        send(set.b, typing(0));
        flush(set.queue, order);
        const before = encodeSharedState(set.a);
        route.replace();
        assert.deepEqual(messages(notices), [[CHANGED, "warn"]]);
        assert.deepEqual(encodeSharedState(set.a), before);
        assert.deepEqual(a.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
        route.replace();
      } finally { route.dispose(); }
      flush(set.queue, order);
      assert.deepEqual(agreeing("retried", set, order)[0], expected("Xa mug of tea"));
      assert.deepEqual(a.owner.sizes(), { undo: 1, redo: 0, dropped: 0 });
    } finally { a.session.dispose(); set.close(); }
  });
  test(`rule 185: a change elsewhere, even in the other cell of the same line, leaves the Replace standing: ${order}`, () => {
    const notices = fakeNotices(), set = setup(source("a cup of tea")), a = copy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try {
        route.search("cup", "mug");
        send(set.b, { ...typing(0), target: { owner: "R1", segment: "R1", field: "visualText" }, at: { left: null, right: flowBaseReference("R1", "visualText", 0), affinity: "before" } });
        send(set.b, { ...typing(0), id: "typed2", target: { owner: "R2", segment: "R2", field: "audioText" }, at: { left: null, right: flowBaseReference("R2", "audioText", 0), affinity: "before" } });
        flush(set.queue, order);
        route.replace();
      } finally { route.dispose(); }
      flush(set.queue, order);
      assert.deepEqual(messages(notices), []);
      const rows = agreeing("elsewhere", set, order);
      assert.deepEqual(rows[0], { ...expected("a mug of tea"), visualText: "X" });
      assert.equal(rows[1]?.audioText, "Xa cup");
    } finally { a.session.dispose(); set.close(); }
  });
  test(`rule 185: a change that reaches the copy after its Replace ran merges as concurrent typing: ${order}`, () => {
    const notices = fakeNotices(), set = setup(source("a cup of tea")), a = copy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try { route.search("cup", "mug"); route.replace(); } finally { route.dispose(); }
      send(set.b, typing(0));
      flush(set.queue, order);
      assert.deepEqual(messages(notices), []);
      assert.deepEqual(agreeing("after", set, order)[0], expected("Xa mug of tea"));
    } finally { a.session.dispose(); set.close(); }
  });
  test(`rule 186: Replace all replaces what matches when it runs, skipping a match that changed and taking a new one: ${order}`, () => {
    const notices = fakeNotices(), set = setup(source("cup and cup")), a = copy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try {
        route.search("cup", "mug");
        send(set.b, typing(1), typing(10, true, "typed2", " cup"));
        flush(set.queue, order);
        route.replaceAll();
      } finally { route.dispose(); }
      flush(set.queue, order);
      assert.deepEqual(messages(notices), [["Replaced 3 matches", "ok"]]);
      assert.deepEqual(agreeing("skipped", set, order).map(row => row.audioText), ["cXup and mug mug", "a mug"]);
    } finally { a.session.dispose(); set.close(); }
  });
  test(`rule 186: a change that reaches the copy after its Replace all ran merges as concurrent typing: ${order}`, () => {
    const notices = fakeNotices(), set = setup(source("cup and cup")), a = copy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try { route.search("cup", "mug"); route.replaceAll(); } finally { route.dispose(); }
      send(set.b, typing(1));
      flush(set.queue, order);
      assert.deepEqual(messages(notices), [["Replaced 3 matches", "ok"]]);
      assert.deepEqual(agreeing("merged", set, order).map(row => row.audioText), ["Xmug and mug", "a mug"]);
    } finally { a.session.dispose(); set.close(); }
  });
}

for (const order of ORDERS) {
  test(`undo of a shared Replace takes back only this person's replacement; redo brings it back: ${order}`, () => {
    const notices = fakeNotices(), set = setup(source("a cup of tea")), a = copy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try { route.search("cup", "mug"); route.replace(); } finally { route.dispose(); }
      send(set.b, typing(11, true));
      flush(set.queue, order);
      assert.deepEqual(a.owner.sizes(), { undo: 1, redo: 0, dropped: 0 });
      assert.equal(a.owner.undo().ok, true);
      flush(set.queue, order);
      assert.deepEqual(agreeing("undone", set, order)[0]?.audioText, "a cup of teaX");
      assert.equal(a.owner.redo().ok, true);
      flush(set.queue, order);
      assert.deepEqual(agreeing("redone", set, order)[0]?.audioText, "a mug of teaX");
    } finally { a.session.dispose(); set.close(); }
  });
  test(`Replace all is one undo step on every cell it changed, and undo keeps the other copy's typing: ${order}`, () => {
    const notices = fakeNotices(), document = source("cup and cup");
    (document.rows as Record<string, unknown>[])[0] = { id: "R1", status: "todo", audioText: "cup and cup", visualText: "cup shot" };
    const set = setup(document), a = copy(set.a, "Alice", notices);
    try {
      const route = finder(a.session, notices, a.shared);
      try { route.search("cup", "mug"); route.replaceAll(); } finally { route.dispose(); }
      assert.deepEqual(messages(notices), [["Replaced 4 matches", "ok"]]);
      send(set.b, typing(5));
      flush(set.queue, order);
      assert.deepEqual(agreeing("all", set, order).map(row => [row.audioText, row.visualText]), [["mug aXnd mug", "mug shot"], ["a mug", ""]]);
      assert.deepEqual(a.owner.sizes(), { undo: 1, redo: 0, dropped: 0 });
      assert.equal(a.owner.undo().ok, true);
      flush(set.queue, order);
      assert.deepEqual(agreeing("undone", set, order).map(row => [row.audioText, row.visualText]), [["cup aXnd cup", "cup shot"], ["a cup", ""]]);
    } finally { a.session.dispose(); set.close(); }
  });
}

test("a used-up undo of a shared Replace writes nothing and leaves no redo", () => {
  const notices = fakeNotices(), set = setup(source("a cup of tea")), a = copy(set.a, "Alice", notices), b = copy(set.b, "Bob", fakeNotices());
  try {
    const route = finder(a.session, notices, a.shared);
    try { route.search("cup", "mug"); route.replace(); } finally { route.dispose(); }
    const cut: SharedOperation[] = [operation({ ...deleting(2, 5, "bob_cut"), by: "Bob" })];
    assert.equal(b.session.run(sharedCommand("cut", cut, { base: readSharedRevision(set.b) })).kind, "applied");
    flush(set.queue, "D1");
    assert.equal(b.owner.undo().ok, true);
    flush(set.queue, "D1");
    const shown = agreeing("restored by the other copy", set)[0]?.audioText as string;
    const at = shown.indexOf("mug");
    send(set.b, deleting(at, at + 3, "bob_cut2"));
    flush(set.queue, "D1");
    assert.equal(agreeing("replacement gone", set)[0]?.audioText, "a cup of tea");
    const before = encodeSharedState(set.a);
    assert.deepEqual(a.owner.undo(), { ok: true, effective: false, label: "replace-match", selection: null, reason: "used-up" });
    assert.deepEqual(encodeSharedState(set.a), before);
    assert.deepEqual(a.owner.sizes(), { undo: 0, redo: 0, dropped: 0 });
  } finally { a.session.dispose(); b.session.dispose(); set.close(); }
});

test("with no shared session the Find routes take the standalone path and ask for no author", () => {
  let asked = 0;
  const notices = fakeNotices(), h = harness();
  h.session.adopt(source("cup and cup"));
  const route = finder(h.session, notices, () => null);
  try { route.search("cup", "mug"); route.replace(); route.replaceAll(); } finally { route.dispose(); }
  assert.equal(h.session.read(doc => doc?.rows[0]?.audioText), "mug and mug");
  assert.deepEqual(messages(notices), [["Replaced 2 matches", "ok"]]);
  const counting = sharedRewritePorts({ handle: () => null, author: () => { asked++; return null; }, stamps: bufferStamps("Alice"), cells: cellOf, readers: bufferReaders });
  assert.equal(counting(), null);
  assert.equal(asked, 0);
});
