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
  assert.equal(err.message, "not-found");
});

// Review client reads comment-route 404s as code "404" (#71)
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
