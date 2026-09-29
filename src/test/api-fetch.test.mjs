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

test("a link's refusals: link-off, owner-only, wrong-document", async () => {
  answering(401, { error: "link-off" });
  assert.equal((await failureOf(apiFetch("api/docs/d", { method: "PUT", body: {} }))).code, "link-off");
  answering(403, { error: "link-off" });
  assert.equal((await failureOf(apiFetch("api/me"))).code, "link-off");
  answering(410, { error: "link-off" });
  assert.equal((await failureOf(apiFetch("api/docs/d"))).code, "link-off");
  answering(403, { error: "owner-only" });
  assert.equal((await failureOf(apiFetch("api/docs", { method: "POST", body: {} }))).code, "owner-only");
  answering(403, { error: "wrong-document" });
  assert.equal((await failureOf(apiFetch("api/docs/other"))).code, "wrong-document");
  answering(401, { error: "pin-required" });
  assert.equal((await failureOf(apiFetch("api/me"))).code, "pin");
  answering(403, { error: "review-only" });
  assert.equal((await failureOf(apiFetch("api/docs/d", { method: "PUT", body: {} }))).code, "review-only");
  answering(403, { error: "something-else" });
  assert.equal((await failureOf(apiFetch("api/me"))).code, "auth");
  answering(410, { error: "gone" });
  assert.equal((await failureOf(apiFetch("api/docs/d"))).code, "410");
});

test("asking another server: opts.base and opts.token, the tab's connection untouched", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), token: init.headers["x-splitpage-token"] || "", credentials: init.credentials });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await apiFetch("api/health", { base: "https://script.example.com", token: "" });
  await apiFetch("api/me", { base: "https://script.example.com/", token: "owner-token" });
  await apiFetch("api/me");
  assert.equal(seen[0].url, "https://script.example.com/api/health");
  assert.equal(seen[0].token, "");
  assert.equal(seen[0].credentials, "omit");
  assert.equal(seen[1].url, "https://script.example.com/api/me");
  assert.equal(seen[1].token, "owner-token");
  assert.equal(seen[2].url, "api/me");
  assert.equal(seen[2].token, "");
  assert.equal(seen[2].credentials, "same-origin");
});

test("other statuses are still named by their number", async () => {
  answering(400, { error: "bad-state" });
  const err = await failureOf(apiFetch("api/docs/d", { method: "PUT", body: {} }));
  assert.equal(err.code, "400");
  assert.equal(err.message, "bad-state");
});
