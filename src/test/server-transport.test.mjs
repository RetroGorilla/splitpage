import test from "node:test";
import assert from "node:assert/strict";

const { createServerTransport } = await import("../adapters/transport/server-transport.ts");

function recorder(answer) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return answer ? answer(url, init) : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { seen, fetch };
}

test("a transport sends every request to the server and with the token it was made with", async () => {
  const live = { serverUrl: "https://one.example/", token: "first" };
  const r = recorder();
  const t = createServerTransport(live, { fetch: r.fetch, caps: () => ({ blobs: false, noClientHeader: false }) });
  live.serverUrl = "https://two.example/";
  live.token = "second";
  await t.request("api/docs/a", { method: "PUT", body: { x: 1 } });
  await t.request("/api/blobs/missing", { method: "POST", body: { shas: [] } });
  assert.deepEqual(r.seen.map((s) => s.url), ["https://one.example/api/docs/a", "https://one.example/api/blobs/missing"]);
  assert.deepEqual(r.seen.map((s) => s.init.headers["x-splitpage-token"]), ["first", "first"]);
  assert.deepEqual(r.seen.map((s) => s.init.credentials), ["omit", "omit"]);
  assert.equal(t.connection.token, "first");
  assert.ok(Object.isFrozen(t.connection));
});

test("the tab's own origin is same-origin with no token header when there is none", async () => {
  const r = recorder();
  const t = createServerTransport({ serverUrl: "", token: "" }, { fetch: r.fetch, caps: () => ({ blobs: true, noClientHeader: false }) });
  await t.request("api/health");
  assert.equal(r.seen[0].url, "api/health");
  assert.equal(r.seen[0].init.credentials, "same-origin");
  assert.equal(r.seen[0].init.headers["x-splitpage-token"], undefined);
  assert.equal(r.seen[0].init.headers["x-splitpage-client"], "2");
  assert.equal(t.takesBlobs(), true);
});

test("the client header follows the server's capabilities, read at each request", async () => {
  const caps = { blobs: false, noClientHeader: false };
  const r = recorder();
  const t = createServerTransport({ serverUrl: "https://one.example/", token: "" }, { fetch: r.fetch, caps: () => caps });
  await t.request("api/me");
  caps.noClientHeader = true;
  await t.request("api/me");
  assert.equal(r.seen[0].init.headers["x-splitpage-client"], "2");
  assert.equal(r.seen[1].init.headers["x-splitpage-client"], undefined);
});

test("a raw upload sends its bytes and type; a blob GET answers null for a failure or a redirect", async () => {
  const r = recorder((url) => {
    if (url.endsWith("gone")) return new Response("", { status: 404 });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const t = createServerTransport({ serverUrl: "https://one.example/", token: "k" }, { fetch: r.fetch, caps: () => ({ blobs: true, noClientHeader: false }) });
  const bytes = new Uint8Array([1, 2, 3]);
  await t.request("api/blobs/abc", { method: "PUT", raw: bytes, contentType: "image/png" });
  assert.equal(r.seen[0].init.body, bytes);
  assert.equal(r.seen[0].init.headers["Content-Type"], "image/png");
  assert.equal(await t.get("api/blobs/gone", "image/*"), null);
  assert.ok(await t.get("api/blobs/here", "image/*"));
  assert.equal(r.seen[2].init.headers["x-splitpage-token"], "k");
});

test("an unreachable server is code offline", async () => {
  const t = createServerTransport({ serverUrl: "https://one.example/", token: "" }, {
    fetch: async () => { throw new TypeError("network"); },
    caps: () => ({ blobs: false, noClientHeader: false })
  });
  await assert.rejects(t.request("api/me"), (e) => e.code === "offline");
  assert.equal(await t.get("api/blobs/x", "image/*"), null);
});
