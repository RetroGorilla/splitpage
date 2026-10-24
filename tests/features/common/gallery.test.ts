import test from "node:test";
import assert from "node:assert/strict";
import { slotPoster } from "../../../src/features/common/gallery.ts";

test("slotPoster returns the first poster link and otherwise null", () => {
  const first = { href: "https://example.com/first", poster: true };
  const second = { href: "https://example.com/second", poster: true };
  assert.equal(slotPoster({ links: [{ href: "https://example.com/plain" }, first, second] }), first);
  assert.equal(slotPoster({ links: [] }), null);
  assert.equal(slotPoster({ links: [{ href: "https://example.com/plain" }] }), null);
});
