import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellOf, inertBody, sanitizeHtml } from "../../../src/bootstrap/richtext.ts";
import { rewriteCellsCommand } from "../../../src/application/commands/document-edit.ts";
import { findQueryChanged, mountFindEvents, startFind } from "../../../src/features/find/find.ts";
import type { CommonDocumentSession } from "../../../src/application/session/document-session.ts";
import { harness } from "../../application/session-fakes.ts";
import { bufferStamps } from "../../collab/buffer-readers.ts";
import { fakeNotices } from "../fakes.ts";

const FIND_AT = "2026-11-14T10:00:00.000Z";
const BAR = '<div id="findbar"><input id="find-input"><input id="replace-input"><span id="find-count"></span><button id="find-next"></button>' +
  '<button id="find-replace"></button><button id="find-replace-all"></button></div><div id="find-tag-row" hidden></div><button id="find-tag"></button>';

interface Reading { readonly read: CommonDocumentSession["read"]; readonly run: CommonDocumentSession["run"]; readonly subscribe: CommonDocumentSession["subscribe"] }
type Notices = ReturnType<typeof fakeNotices>;

function source(cell: string, visual = false): Record<string, unknown> {
  return { schema: 2, docId: "d00000000000000000000000000000000", title: "",
    rows: [{ id: "R1", status: "todo", audioText: visual ? "" : cell, visualText: visual ? cell : "" }, { id: "R2", status: "todo", audioText: "a cup" }],
    comments: [{ id: "C1", author: "Ann", createdAt: FIND_AT, rowId: "R1", field: "audioText", anchorId: "C1", body: "note", quotedText: "cup", resolved: false, resolvedAt: null, resolvedBy: null }],
    productionTags: [{ id: "t_1", cat: "prop", name: "Gaffer tape", status: "needed" }],
    brollShots: [{ id: "S1", name: "Cup", status: "unshot", origin: "list" }] };
}

function finder(session: Reading, notices: Notices, matchCase = false) {
  (globalThis as unknown as Record<string, unknown>).CSS = window.CSS;
  document.body.innerHTML = BAR;
  const mounted = startFind({
    sharedCommands: { refuseUnsupported: () => false },
    document: { current: () => session.read(doc => doc), read: session.read, onChange: session.subscribe },
    edits: { edit: command => session.run(command).kind === "applied", stamps: bufferStamps("Alice", () => FIND_AT) },
    text: { cellOf, inertBody, sanitizeHtml },
    shotHiding: () => ({ reveal: () => {} }), undo: { breakCoalescing: () => {} }, notices: notices.notices,
    flags: { setFindOpen: () => {} }, options: { matchesCase: () => matchCase }, bulkTag: () => ({ hits: 0, inTags: 0, skipped: 0 }),
    present: { isOpen: () => false, setSearching: () => {}, jump: () => {}, onViewChange: () => () => {} }
  });
  const events = mountFindEvents({ matchesCase: () => matchCase, setMatchCase: () => {} });
  const input = (id: string, value: string) => { (document.getElementById(id) as HTMLInputElement).value = value; };
  const click = (id: string) => { (document.getElementById(id) as HTMLElement).click(); };
  return {
    search: (find: string, put: string) => { input("find-input", find); input("replace-input", put); findQueryChanged(); },
    next: () => click("find-next"),
    replace: () => click("find-replace"),
    replaceAll: () => click("find-replace-all"),
    dispose: () => { events.dispose(); mounted.dispose(); }
  };
}

function act(route: ReturnType<typeof finder>, step: { readonly find: string; readonly put: string; readonly all?: boolean | undefined; readonly nth?: number }) {
  route.search(step.find, step.put);
  if (step.all) { route.replaceAll(); return; }
  for (let next = 0; next < (step.nth ?? 0); next++) route.next();
  route.replace();
}

const TOKEN = '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>';
const TAG = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Gaffer tape" contenteditable="false">gaffer tape</span>';
const CMT = (inner: string) => '<span class="cmt-anchor" data-cmt="C1">' + inner + "</span>";
interface Fixture {
  readonly name: string;
  readonly cell: string;
  readonly find: string;
  readonly put: string;
  readonly all?: boolean;
  readonly nth?: number;
  readonly matchCase?: boolean;
  readonly visual?: boolean;
  readonly picture?: { readonly at: number; readonly bold?: boolean };
  readonly joined?: { readonly audio: string; readonly visual: string; readonly audioAfter?: string };
  readonly after: string;
}

const PIC = '<img class="comment-img" data-blob="' + "a".repeat(64) + '" data-w="10" data-h="10" data-mime="image/png">';
const FIXTURES: readonly Fixture[] = [
  { name: "plain words", cell: "a cup of tea", find: "cup", put: "mug", after: "a mug of tea" },
  { name: "the second match", cell: "cup, cup", find: "cup", put: "mug", nth: 1, after: "cup, mug" },
  { name: "every match", cell: "cup, cup and cup", find: "cup", put: "mug", all: true, after: "mug, mug and mug" },
  { name: "adjacent matches", cell: "cupcup", find: "cup", put: "mug", all: true, after: "mugmug" },
  { name: "a bold match", cell: "a <strong>cup</strong> here", find: "cup", put: "mug", after: "a <strong>mug</strong> here" },
  { name: "a match that runs into bold", cell: "c<strong>up</strong>s", find: "cup", put: "mug", after: "mugs" },
  { name: "a match that starts in bold", cell: "<strong>cu</strong>p!", find: "cup", put: "mug", after: "<strong>mug</strong>!" },
  { name: "bold and plain matches", cell: "<strong>cup</strong> and cup", find: "cup", put: "mug", all: true, after: "<strong>mug</strong> and mug" },
  { name: "a linked match", cell: '<a href="https://e.x/">cup</a> now', find: "cup", put: "mug", after: '<a href="https://e.x/" target="_blank" rel="noopener">mug</a> now' },
  { name: "a match inside a comment", cell: "a " + CMT("cup"), find: "cup", put: "mug", after: "a " + CMT("mug") },
  { name: "matches around a line break", cell: "cup<br>cup", find: "cup", put: "mug", all: true, after: "mug<br>mug" },
  { name: "a stage direction", cell: '<span class="stage-dir">cup</span> ok', find: "cup", put: "mug", after: '<span class="stage-dir">mug</span> ok' },
  { name: "words beside a tag", cell: TAG + " tape", find: "tape", put: "rope", all: true, after: TAG + " rope" },
  { name: "a B-roll key's words in narration", cell: TOKEN + " a cup", find: "cup", put: "mug", after: TOKEN + " a mug" },
  { name: "narration before a B-roll key", cell: "a cup " + TOKEN + " drone", find: "cup", put: "mug", after: "a mug " + TOKEN + " drone" },
  { name: "a B-roll line's shot name", cell: TOKEN + " Cup", find: "Cup", put: "Mug", visual: true, after: TOKEN + " Mug" },
  { name: "words after an @Name", cell: "@Ann reads cup", find: "cup", put: "mug", after: "@Ann reads mug" },
  { name: "a typed @Name", cell: "@Ann reads cup", find: "Ann", put: "Bob", after: "@Bob reads cup" },
  { name: "an empty replacement", cell: "a cup of", find: "cup", put: "", after: "a  of" },
  { name: "any case", cell: "Cup cup CUP", find: "cup", put: "mug", all: true, after: "mug mug mug" },
  { name: "matching case", cell: "Cup cup", find: "cup", put: "mug", all: true, matchCase: true, after: "Cup mug" },
  { name: "a visual cell", cell: "cup shot", find: "cup", put: "mug", visual: true, after: "mug shot" },
  { name: "beside emoji", cell: "\u{1F600}cup\u{1F600}", find: "cup", put: "mug", after: "\u{1F600}mug\u{1F600}" },
  { name: "a replacement holding the words", cell: "cup cup", find: "cup", put: "cupcup", all: true, after: "cupcup cupcup" },
  { name: "markup characters in the replacement", cell: "a cup of", find: "cup", put: "<b>&", after: "a &lt;b&gt;&amp; of" },
  { name: "a picture before the match", cell: "cup", find: "cup", put: "mug", picture: { at: 0 }, after: PIC + "mug" },
  { name: "a picture right after the match", cell: "a cup.", find: "cup", put: "mug", picture: { at: 5 }, after: "a mug" + PIC + "." },
  { name: "a picture inside the bold run before the match", cell: "<strong>cup</strong> x", find: "cup", put: "mug", picture: { at: 0, bold: true },
    after: "<strong>" + PIC + "mug</strong> x" },
  { name: "a picture inside the bold run after the match", cell: "<strong>cup!</strong>", find: "cup", put: "mug", picture: { at: 3, bold: true },
    after: "<strong>mug" + PIC + "!</strong>" },
  { name: "a picture and a tag before the match", cell: TAG + "cup", find: "cup", put: "mug", picture: { at: 0 }, after: PIC + TAG + "mug" },
  { name: "the second match after a picture", cell: "cup cup", find: "cup", put: "mug", nth: 1, picture: { at: 4 }, after: "cup " + PIC + "mug" },
  { name: "every match around a picture", cell: "cup cup", find: "cup", put: "mug", all: true, picture: { at: 3 }, after: "mug" + PIC + " mug" },
  { name: "a picture before the match in a visual cell", cell: "cup shot", find: "cup", put: "mug", visual: true, picture: { at: 0 }, after: PIC + "mug shot" },
  { name: "every match beside a picture and a tag in a visual cell", cell: TAG + " cup", find: "cup", put: "mug", all: true, visual: true, picture: { at: 0 },
    after: PIC + TAG + " mug" },
  { name: "a match in narration joined from the next line", cell: "a cup of tea", find: "cup", put: "mug", nth: 1, joined: { audio: "the cup", visual: "" },
    after: "a cup of tea the mug" },
  { name: "every match in joined narration", cell: "a cup of tea", find: "cup", put: "mug", all: true, joined: { audio: "the cup", visual: "" },
    after: "a mug of tea the mug" },
  { name: "a visual joined from the next line", cell: "", find: "cup", put: "mug", all: true, visual: true, joined: { audio: "", visual: "cup", audioAfter: " " },
    after: "mug" },
  { name: "a visual joined under this line's visual", cell: "R1", find: "cup", put: "mug", all: true, visual: true, joined: { audio: "", visual: "cup", audioAfter: " " },
    after: "R1<br>mug" },
  { name: "every match, when one of them is in a joined visual", cell: "", find: "cup", put: "mug", all: true, visual: true,
    joined: { audio: "cup", visual: "cup", audioAfter: " mug" }, after: "mug" }
];

for (const fixture of FIXTURES) test("standalone Replace: " + fixture.name, () => {
  const h = harness(), notices = fakeNotices(), document = source(fixture.cell, fixture.visual);
  if (fixture.joined) {
    const cell = fixture.after.replaceAll(fixture.put, fixture.find);
    document.rows = [{ id: "R1", status: "todo", audioText: fixture.visual ? fixture.joined.audioAfter?.replace("mug", "cup") : cell,
      visualText: fixture.visual ? cell : "" }];
  }
  h.session.adopt(document);
  const field = fixture.visual ? "visualText" : "audioText";
  if (fixture.picture) {
    const html = fixture.after.replaceAll(fixture.put, fixture.find);
    assert.equal(h.session.run(rewriteCellsCommand("picture", () => [{ rowId: "R1", field, html }], bufferStamps("Bob"),
      { needs: "edit", stamped: false })).kind, "applied");
  }
  const route = finder(h.session, notices, fixture.matchCase);
  try { act(route, fixture); } finally { route.dispose(); }
  const row = h.session.read(doc => doc?.rows[0]);
  assert.deepEqual([row?.[field], row?.updatedAt, row?.updatedBy], [fixture.after, FIND_AT, "Alice"]);
  if (fixture.joined?.audioAfter !== undefined) assert.equal(row?.audioText, fixture.joined.audioAfter);
});

function shownCell(html: string) {
  const prototype = window.HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
  if (!prototype.scrollIntoView) prototype.scrollIntoView = () => {};
  (window.CSS as unknown as { highlights: Map<string, unknown> }).highlights = new Map();
  const Highlight = class { readonly range: Range; constructor(range: Range) { this.range = range; } };
  (window as unknown as { Highlight: unknown }).Highlight = Highlight;
  (globalThis as unknown as { Highlight: unknown }).Highlight = Highlight;
  document.body.insertAdjacentHTML("beforeend", '<div id="rows"><div class="row" data-id="R1"><div class="cell-editable" data-field="audioText">' + html + "</div></div></div>");
}
function lit() {
  const range = ((window.CSS as unknown as { highlights: Map<string, { range: Range }> }).highlights.get("splitpage-find-match"))?.range;
  return range ? [range.startContainer.nodeValue, range.startOffset, range.endContainer.nodeValue, range.endOffset] : null;
}
const count = () => document.getElementById("find-count")?.textContent;

test("standalone: a picture inside a word is skipped when searching, so highlight and Replace both take that word and the picture is deleted with it", () => {
  const notices = fakeNotices(), h = harness();
  h.session.adopt(source("cup cup"));
  const html = "cu" + PIC + "p cup";
  h.session.run(rewriteCellsCommand("picture", () => [{ rowId: "R1", field: "audioText", html }], bufferStamps("Bob", () => ""), { needs: "edit", stamped: false }));
  const route = finder(h.session, notices);
  try {
    shownCell(html);
    route.search("cup", "mug");
    assert.deepEqual([count(), lit()], ["1 of 3", ["cu", 0, "p cup", 1]]);
    route.replace();
  } finally { route.dispose(); }
  assert.equal(h.session.read(doc => doc?.rows[0]?.audioText), "mug cup");
});

test("standalone Find replaces one match, then the remaining matches", () => {
  const notices = fakeNotices(), h = harness();
  h.session.adopt(source("cup and cup"));
  const route = finder(h.session, notices);
  try { route.search("cup", "mug"); route.replace(); route.replaceAll(); } finally { route.dispose(); }
  assert.equal(h.session.read(doc => doc?.rows[0]?.audioText), "mug and mug");
  assert.deepEqual(notices.shown.map(item => [item.message, item.kind]), [["Replaced 2 matches", "ok"]]);
});
