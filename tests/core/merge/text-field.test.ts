import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTextField, textMergeContext } from "../../../src/core/merge/text-field.ts";
import type { TagSide } from "../../../src/core/merge/text-field.ts";
import type { TagInput } from "../../../src/core/merge/lists.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { T } from "../text/cells.ts";
import { fakeDecoder, jsonCopy, picture } from "./fakes.ts";

const side = (tags?: TagInput[]): TagSide => ({ productionTags: tags || [] });
const html = (cell: Run[]): string => toHtml(cell);

const BASE = [T("the cat sat on the mat")];
const MINE = [T("the dog sat on the mat")];
const THEIRS = [T("the cat sat on the rug")];
const BOTH = [T("the dog sat on the rug")];
const OTHER = [T("the cow sat on the mat")];
const BOLD_TWO = [T("one "), T("two", { b: true }), T(" three")];
const ITALIC_TWO = [T("one "), T("two", { i: true }), T(" three")];
const PLAIN_TWO = [T("one two three")];
const LINK_MINE = [T("see the "), T("docs", { href: "https://mine.example/" }), T(" for more")];
const LINK_THEIRS = [T("see the "), T("docs", { href: "https://theirs.example/" }), T(" for more")];
const LINK_THEIRS_EDITED = [T("see the "), T("docs", { href: "https://theirs.example/" }), T(" for less")];
const LINK_BASE = [T("see the docs for more")];
const LINK_MINE_EDITED = [T("look at the "), T("docs", { href: "https://mine.example/" }), T(" for more")];

const { decode, calls } = fakeDecoder([BASE, MINE, THEIRS, BOTH, OTHER, BOLD_TWO, ITALIC_TWO, PLAIN_TWO,
  LINK_MINE, LINK_THEIRS, LINK_THEIRS_EDITED, LINK_BASE, LINK_MINE_EDITED]);

const ctx = textMergeContext(decode, side(), side(), side());
const noBase = textMergeContext(decode, null, side(), side());

test("each outcome names what the merge took", () => {
  assert.deepEqual(mergeTextField(html(BASE), html(MINE), html(MINE), ctx), { html: html(MINE), outcome: "same" });
  assert.deepEqual(mergeTextField(html(BASE), html(BASE), html(THEIRS), ctx), { html: html(THEIRS), outcome: "theirs" });
  assert.deepEqual(mergeTextField(html(BASE), html(MINE), html(BASE), ctx), { html: html(MINE), outcome: "mine" });
  assert.deepEqual(mergeTextField(html(BASE), html(MINE), html(THEIRS), ctx), { html: html(BOTH), outcome: "merged" });
  assert.deepEqual(mergeTextField(html(BASE), html(MINE), html(OTHER), ctx), { html: html(OTHER), outcome: "conflict" });
});

test("both sides formatting one word two ways is a mark conflict that keeps theirs and says mine was in it", () => {
  assert.deepEqual(mergeTextField(html(PLAIN_TWO), html(BOLD_TWO), html(ITALIC_TWO), ctx),
    { html: toHtml([T("one "), T("two", { b: true, i: true }), T(" three")]), outcome: "merged" });
  const r = mergeTextField(html(LINK_BASE), html(LINK_MINE), html(LINK_THEIRS), ctx);
  assert.deepEqual(r, { html: html(LINK_THEIRS), outcome: "conflict", marks: true, withMine: false });
  const edited = mergeTextField(html(LINK_BASE), html(LINK_MINE_EDITED), html(LINK_THEIRS_EDITED), ctx);
  assert.equal(edited.outcome, "conflict");
  assert.equal(edited.marks, true);
  assert.equal(edited.withMine, true);
});

test("with no base, a difference is a conflict and theirs stays; undefined base means no base", () => {
  assert.deepEqual(mergeTextField(undefined, html(MINE), html(THEIRS), noBase), { html: html(THEIRS), outcome: "conflict" });
  assert.deepEqual(mergeTextField(undefined, html(MINE), html(THEIRS), ctx), { html: html(THEIRS), outcome: "conflict" });
  assert.deepEqual(mergeTextField(html(BASE), html(MINE), html(THEIRS), noBase), { html: html(THEIRS), outcome: "conflict" });
});

test("a base that is undefined is no base, not an empty cell, even when the document has one", () => {
  assert.deepEqual(mergeTextField(undefined, "", html(THEIRS), ctx), { html: html(THEIRS), outcome: "conflict" });
  assert.deepEqual(mergeTextField("", "", html(THEIRS), ctx), { html: html(THEIRS), outcome: "theirs" });
});

test("null and missing cells read as empty", () => {
  assert.deepEqual(mergeTextField(null, null, undefined, ctx), { html: "", outcome: "same" });
  assert.deepEqual(mergeTextField("", html(MINE), null, ctx), { html: html(MINE), outcome: "mine" });
});

test("a cell holding media is never merged word by word", () => {
  const withPic = { html: html(BASE) + "<img data-blob=x>", cell: BASE, media: [picture("a")] };
  const media = fakeDecoder([BASE, MINE, THEIRS, withPic]);
  const c = textMergeContext(media.decode, side(), side(), side());
  assert.deepEqual(mergeTextField(html(BASE), withPic.html, html(BASE), c), { html: withPic.html, outcome: "mine" });
  assert.deepEqual(mergeTextField(html(BASE), html(BASE), withPic.html, c), { html: withPic.html, outcome: "theirs" });
  assert.deepEqual(mergeTextField(html(BASE), withPic.html, html(THEIRS), c), { html: html(THEIRS), outcome: "conflict" });
  assert.deepEqual(mergeTextField(withPic.html, html(MINE), html(THEIRS), c), { html: html(THEIRS), outcome: "conflict" });
});

test("cells are read only through the decoder, and an unchanged cell is not read", () => {
  calls.length = 0;
  mergeTextField(html(BASE), html(MINE), html(MINE), ctx);
  assert.deepEqual(calls, []);
  mergeTextField(html(BASE), html(MINE), html(THEIRS), ctx);
  assert.deepEqual(calls, [html(MINE), html(THEIRS), html(BASE)]);
  calls.length = 0;
  mergeTextField(html(MINE), html(MINE), html(THEIRS), ctx);
  assert.deepEqual(calls, [html(MINE), html(THEIRS)], "a base equal to one side is that side's reading");
});

test("a tag renamed in the registry is written under its new name, through the merged registry", () => {
  const MUG = [T("pour the "), T("mug", { tag: "t:prop:Mug" }), T(" out")];
  const CUP = [T("pour the "), T("mug", { tag: "t:prop:Cup" }), T(" out")];
  const tags = fakeDecoder([MUG, CUP]);
  const base = side([{ id: "t_mug", cat: "prop", name: "Mug" }]);
  const mine = side([{ id: "t_mug", cat: "prop", name: "Cup" }]);
  const theirs = side([{ id: "t_mug", cat: "prop", name: "Mug" }]);
  const c = textMergeContext(tags.decode, base, mine, theirs);
  assert.deepEqual(c.refit, { mine: false, theirs: true });
  assert.deepEqual(mergeTextField(html(MUG), html(MUG), html(MUG), c), { html: html(CUP), outcome: "same" });
  const unrenamed = textMergeContext(tags.decode, base, theirs, theirs);
  tags.calls.length = 0;
  assert.deepEqual(mergeTextField(html(MUG), html(MUG), html(MUG), unrenamed), { html: html(MUG), outcome: "same" });
  assert.deepEqual(tags.calls, [], "nothing to refit when no side's registry was renamed");
});

test("a tag whose category alone changed in the registry is written under its new category", () => {
  const PROP = [T("the "), T("lamp", { tag: "t:prop:Lamp" })];
  const GEAR = [T("the "), T("lamp", { tag: "t:gear:Lamp" })];
  const tags = fakeDecoder([PROP, GEAR]);
  const base = side([{ id: "t_lamp", cat: "prop", name: "Lamp" }]);
  const c = textMergeContext(tags.decode, base, side([{ id: "t_lamp", cat: "gear", name: "Lamp" }]), base);
  assert.deepEqual(c.refit, { mine: false, theirs: true });
  assert.deepEqual(mergeTextField(html(PROP), html(PROP), html(PROP), c), { html: html(GEAR), outcome: "same" });
});

test("a tag the merged registry dropped is named from theirs first, then mine, then the base", () => {
  const named = (name: string) => [{ id: "t_x", cat: "prop", name: name }];
  const tagOf = (b: TagInput[], m: TagInput[], t: TagInput[], merged: TagInput[]) =>
    textMergeContext(decode, side(b), side(m), side(t), merged as { id: string; cat: string; name: string }[]).out.tagOf("t_x");
  assert.deepEqual(tagOf(named("Base"), named("Mine"), named("Theirs"), named("Merged")), { cat: "prop", name: "Merged" });
  assert.deepEqual(tagOf(named("Base"), named("Mine"), named("Theirs"), []), { cat: "prop", name: "Theirs" });
  assert.deepEqual(tagOf(named("Base"), named("Mine"), [], []), { cat: "prop", name: "Mine" });
  assert.deepEqual(tagOf(named("Base"), [], [], []), { cat: "prop", name: "Base" });
  assert.equal(tagOf([], [], [], []), null);
});

test("a context is built from each side's registry without changing it, and takes a given merged registry", () => {
  const mine = [{ cat: "prop", name: "Kettle" }, { id: "t_lamp", cat: "prop", name: "Lamp" }];
  const before = jsonCopy(mine);
  const c = textMergeContext(decode, null, side(mine), side());
  assert.deepEqual(mine, before);
  assert.equal(c.hasBase, false);
  assert.equal(c.mine.tagId("prop", "lamp"), "t_lamp");
  assert.match(c.mine.tagId("prop", "Kettle"), /^t_[a-z0-9]+$/);
  assert.equal(c.out.tagId("prop", "Lamp"), "t_lamp", "the merged registry is mine plus theirs");
  const given = textMergeContext(decode, side(), side(mine), side(), [{ id: "t_x", cat: "gear", name: "Tripod" }]);
  assert.equal(given.out.tagId("prop", "Lamp"), "t:prop:Lamp");
  assert.deepEqual(given.out.tagOf("t_lamp"), { cat: "prop", name: "Lamp" }, "an id the merge dropped is still named from a side");
  assert.deepEqual(given.out.tagOf("t_x"), { cat: "gear", name: "Tripod" });
  assert.equal(given.decode, decode);
});
