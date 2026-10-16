import test from "node:test";
import assert from "node:assert/strict";
import { authorityOf, editCapability, isLinkGuest, isOwner, isReviewer } from "../application/collaboration/authority.ts";

const facts = (token, role, scope) => ({ token, role, scope });

test("no connection and a signed-out connection have no authority", () => {
  assert.equal(authorityOf(null).kind, "none");
  assert.equal(authorityOf(facts("", "", "")).kind, "none");
});

test("a signed-in connection without a scope is the owner", () => {
  const a = authorityOf(facts("t", "edit", ""));
  assert.equal(a.kind, "owner");
  assert.ok(isOwner(a) && !isLinkGuest(a) && !isReviewer(a));
  assert.deepEqual(editCapability(a), { allowed: true });
});

test("a scoped editor can edit but is a link guest and not the owner", () => {
  const a = authorityOf(facts("t", "edit", "srv-a"));
  assert.equal(a.kind, "scoped-editor");
  assert.ok(isLinkGuest(a) && !isOwner(a));
  assert.deepEqual(editCapability(a), { allowed: true });
});

test("a reviewer cannot edit, with or without a scope", () => {
  for (const scope of ["", "srv-a"]) {
    const a = authorityOf(facts("t", "review", scope));
    assert.equal(a.kind, "reviewer");
    assert.ok(isReviewer(a) && !isOwner(a));
    assert.deepEqual(editCapability(a), { allowed: false, reason: "review" });
    assert.equal(isLinkGuest(a), scope !== "");
  }
});
