/* What apiFetch() (13-hosted.js) calls a failed answer — the `code` every
 * caller branches on.
 *
 * #99: saveToServer() had a branch for a document deleted on the server,
 * `err.code === "not-found"`, that never ran, because apiFetch() named every
 * non-ok status by its number and the server's 404 {error:"not-found"}
 * arrived as code "404". The server's own "no such document" now has a name
 * of its own, the way a 409 is "conflict"; every other 404 — the comment
 * routes' "no-such-comment" above all, which the review client reads as
 * code "404" plus the reason in the message (#71) — keeps its number.
 *
 * `fetch` is replaced per test; nothing here needs a server or a page.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const { apiFetch } = await import("../js/13-hosted.js");

function answering(status, body) {
  globalThis.fetch = async () => new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function failureOf(p) {
  try { await p; } catch (e) { return e; }
  assert.fail("expected apiFetch to reject");
}

const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

test("the server's 404 not-found is code \"not-found\"", async () => {
  answering(404, { error: "not-found" });
  const err = await failureOf(apiFetch("api/docs/gone", { method: "PUT", body: { baseRev: 1, state: {} } }));
  assert.equal(err.code, "not-found");
  /* the message is what handleApiError() prints, and it did not change */
  assert.equal(err.message, "not-found");
});

test("any other 404 keeps its number, with the reason as the message", async () => {
  answering(404, { error: "no-such-comment" });
  const err = await failureOf(apiFetch("api/docs/d/comments/c1", { method: "PATCH", body: { resolved: true } }));
  assert.equal(err.code, "404");
  assert.equal(err.message, "no-such-comment");

  answering(404, {});
  const bare = await failureOf(apiFetch("api/docs/d"));
  assert.equal(bare.code, "404");
  assert.equal(bare.message, "HTTP 404");
});

test("a 409 is still \"conflict\" with the body as its payload, and a 200 is the body", async () => {
  answering(409, { error: "conflict", rev: 4, state: { rows: [] } });
  const err = await failureOf(apiFetch("api/docs/d", { method: "PUT", body: { baseRev: 3, state: {} } }));
  assert.equal(err.code, "conflict");
  assert.equal(err.payload.rev, 4);

  answering(200, { id: "d", rev: 5 });
  assert.deepEqual(await apiFetch("api/docs/d"), { id: "d", rev: 5 });
});

test("other statuses are still named by their number", async () => {
  answering(400, { error: "bad-state" });
  const err = await failureOf(apiFetch("api/docs/d", { method: "PUT", body: {} }));
  assert.equal(err.code, "400");
  assert.equal(err.message, "bad-state");
});
