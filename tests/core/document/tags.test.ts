import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAG_CATEGORY_IDS,
  TAG_STATUS_IDS,
  ensureTagIds,
  isTagId,
  mintTagId,
  nextTagStatus,
  normalizeTagName,
  registryKey,
  registryTagHooks,
  tagCategoryId,
  tagKey,
  tagStatusId,
  tagStatusRank
} from "../../../src/core/document/tags.ts";
import type { TagRecord } from "../../../src/core/document/tags.ts";

const ODD_IDS: unknown[] = ["", null, undefined, "bogus", "constructor", "toString", "__proto__", 0, 1];

test("the category and status ids, in their order", () => {
  assert.deepEqual([...TAG_CATEGORY_IDS], ["prop", "location", "cast", "vfx", "sound", "gear"]);
  assert.deepEqual([...TAG_STATUS_IDS], ["needed", "sourcing", "have", "returned"]);
});

test("a category or status id is known exactly, or not at all", () => {
  for (const id of TAG_CATEGORY_IDS) assert.equal(tagCategoryId(id), id);
  for (const id of TAG_STATUS_IDS) assert.equal(tagStatusId(id), id);
  for (const id of [...ODD_IDS, "Prop", "prop ", "Needed"]) {
    assert.equal(tagCategoryId(id), null, String(id));
    assert.equal(tagStatusId(id), null, String(id));
  }
});

test("a status's rank is its place, an unknown one ranks first, and next cycles round", () => {
  assert.deepEqual(TAG_STATUS_IDS.map(tagStatusRank), [0, 1, 2, 3]);
  assert.deepEqual(TAG_STATUS_IDS.map(nextTagStatus), ["sourcing", "have", "returned", "needed"]);
  for (const id of ODD_IDS) {
    assert.equal(tagStatusRank(id), 0, String(id));
    assert.equal(nextTagStatus(id), "sourcing", String(id));
  }
});

test("a tag name normalises case and white space; keys join the category to it", () => {
  assert.equal(normalizeTagName("  Red \t  MUG\n"), "red mug");
  assert.equal(normalizeTagName(null), "");
  assert.equal(normalizeTagName(undefined), "");
  assert.equal(normalizeTagName(42), "42");
  assert.equal(tagKey("prop", " Red  Mug "), "prop red mug");
  assert.equal(registryKey("prop", " Red  Mug "), "prop red mug");
  assert.equal(registryKey("location", "Red mug"), "location red mug");
});

test("a tag id is t_ with up to sixteen base-36 characters and an optional counter", () => {
  for (const id of ["t_a", "t_" + "z".repeat(16), "t_abc-2", "t_abc-999999"]) assert.equal(isTagId(id), true, id);
  for (const id of ["t:prop:x", "", null, "t_<x>", "t_", "t_" + "a".repeat(17), "t_abc-", "t_abc-1234567", "T_abc", 7]) {
    assert.equal(isTagId(id), false, String(id));
  }
});

test("a tag id is minted from the key (frozen), counting up past the ids already taken", () => {
  assert.equal(mintTagId("prop", "Red mug"), "t_13ff9pk7vdcv3");
  assert.equal(mintTagId("sound", "Rain"), "t_eu7ua1agbdn9");
  assert.equal(mintTagId("location", "Roof"), "t_10deh5c1mxo89q");
  const a = mintTagId("prop", "Red mug");
  assert.equal(mintTagId("prop", "  red   MUG "), a);
  assert.equal(mintTagId("prop", "Red mug", [{ id: a }]), a + "-2");
  assert.equal(mintTagId("prop", "Red mug", [null, { id: a }, { id: a + "-2" }, undefined]), a + "-3");
  assert.equal(mintTagId("prop", "Red mug", null), a);
});

test("ensureTagIds keeps the first of each valid id and mints the rest, in place", () => {
  const reg: (TagRecord | null)[] = [
    { cat: "prop", name: "A", id: "t_keep" },
    null,
    { cat: "prop", name: "B", id: "t_keep" },
    { cat: "prop", name: "C", id: "bad id" },
    { cat: "prop", name: "D" }
  ];
  assert.equal(ensureTagIds(reg), reg);
  assert.deepEqual(reg.map((t) => t && t.id), ["t_keep", null, mintTagId("prop", "B"), mintTagId("prop", "C"), mintTagId("prop", "D")]);
  assert.equal(ensureTagIds(null), null);
  assert.equal(ensureTagIds(undefined), undefined);
});

test("ensureTagIds mints against the whole registry, so a fresh id never repeats one already there", () => {
  const taken = mintTagId("prop", "A");
  const reg: TagRecord[] = [{ cat: "prop", name: "A" }, { cat: "prop", name: "Z", id: taken }];
  ensureTagIds(reg);
  assert.equal(reg[0]?.id, taken + "-2");
  assert.equal(reg[1]?.id, taken);
});

test("registry tag hooks name a tag by its registry id, else by its category and name", () => {
  const hooks = registryTagHooks([
    { id: "t_mug", cat: "prop", name: "Mug" },
    { id: "t_mug2", cat: "prop", name: "mug" },
    { cat: "prop", name: "No id" },
    { id: "t_blank", cat: "prop", name: "" },
    null
  ]);
  assert.equal(hooks.tagId("prop", "MUG"), "t_mug");
  assert.equal(hooks.tagId("prop", "No id"), "t:prop:No id");
  assert.equal(hooks.tagId("location", "Mug"), "t:location:Mug");
  assert.deepEqual(hooks.tagOf("t_mug"), { cat: "prop", name: "Mug" });
  assert.deepEqual(hooks.tagOf("t_mug2"), { cat: "prop", name: "mug" });
  assert.deepEqual(hooks.tagOf("t:vfx:Smoke: thick"), { cat: "vfx", name: "Smoke: thick" });
  assert.equal(hooks.tagOf("t_blank"), null);
  assert.equal(hooks.tagOf("t:Prop:x"), null);
  assert.equal(hooks.tagOf(null), null);
  assert.deepEqual(registryTagHooks(undefined).tagOf("t:cast:Ada"), { cat: "cast", name: "Ada" });
});
