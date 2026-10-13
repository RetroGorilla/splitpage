import test from "node:test";
import assert from "node:assert/strict";
import {
  conn,
  home,
  homeConn,
  normalizeServerUrl,
  restoreHome,
  setConnection,
  serverOf,
  setHome,
  stillOnServer,
  updateConnection
} from "../js/_home.js";

test("a tab starts on its own origin's server, with nothing proved there", () => {
  assert.deepEqual(conn, { serverUrl: "", token: "", role: "", scope: "", tunnel: null });
  assert.equal(homeConn(), null);
});

test("server addresses are normalized one way", () => {
  assert.equal(normalizeServerUrl(""), "");
  assert.equal(normalizeServerUrl("  "), "");
  assert.equal(normalizeServerUrl("192.168.1.20:8791"), "http://192.168.1.20:8791/");
  assert.equal(normalizeServerUrl("https://studio.example.com///"), "https://studio.example.com/");
  assert.equal(normalizeServerUrl("http://a:1/"), "http://a:1/");
});

test("setConnection replaces the record whole and validates every field", () => {
  const a = setConnection({ serverUrl: "http://a:1/", token: "t1", role: "edit" });
  assert.equal(conn, a);
  assert.deepEqual(a, { serverUrl: "http://a:1/", token: "t1", role: "edit", scope: "", tunnel: null });
  const b = setConnection({ serverUrl: "http://b:2/" });
  assert.notEqual(b, a);
  assert.deepEqual(b, { serverUrl: "http://b:2/", token: "", role: "", scope: "", tunnel: null });

  assert.throws(() => setConnection({ serverUrl: "b:2" }), /not a normalized base/);
  assert.throws(() => setConnection({ serverBase: "http://b:2/" }), /no field "serverBase"/);
  assert.throws(() => setConnection({ role: "admin" }), /unknown role "admin"/);
  assert.throws(() => setConnection({ token: 5 }), /a token is a string/);
  assert.equal(conn, b, "a refused setConnection leaves the connection where it was");
  setConnection({});
});

test("a tunnel is host and ports, and nothing that could carry a secret", () => {
  const t = setConnection({ serverUrl: "http://localhost:8899/",
    tunnel: { userHost: "me@studio.example.com", remotePort: 8791, localPort: 8899 } });
  assert.deepEqual(t.tunnel, { userHost: "me@studio.example.com", remotePort: 8791, localPort: 8899 });
  assert.throws(() => setConnection({ tunnel: { userHost: "me@h", remotePort: 1, localPort: 2, password: "x" } }),
    /tunnel has no field "password"/);
  assert.throws(() => setConnection({ tunnel: { userHost: "me@h -o ProxyCommand=x", remotePort: 1, localPort: 2 } }),
    /needs a userHost/);
  assert.throws(() => setConnection({ tunnel: { userHost: "-oProxyCommand=x", remotePort: 1, localPort: 2 } }),
    /needs a userHost/);
  assert.throws(() => setConnection({ tunnel: { userHost: "me@h", remotePort: 0, localPort: 2 } }), /ports/);
  assert.throws(() => setConnection({ tunnel: "me@h" }), /a tunnel is null/);
  setConnection({});
});

test("a server home holds this tab's connection, and moves to the new one when a token arrives later", () => {
  const c = setConnection({ serverUrl: "http://a:1/" });
  const h = setHome("server", { id: "doc-1", rev: 3 });
  assert.equal(h.conn, c);
  assert.equal(homeConn(), c);
  const next = updateConnection({ token: "tok", role: "review" });
  assert.notEqual(next, c, "a token or role change is a new connection instance");
  assert.equal(conn, next);
  assert.equal(home, h, "the home is the same destination");
  assert.equal(home.conn, next, "and it moved to the new connection");
  assert.equal(home.conn.token, "tok");
  assert.equal(home.conn.role, "review");
  assert.equal(c.token, "", "the old instance keeps what it had");
  assert.equal(c.role, "");
  assert.ok(Object.isFrozen(next), "an instance never changes once made");
  assert.equal(stillOnServer(c), true, "the old instance is on the same server");
  setHome("none");
  setConnection({ serverUrl: "http://a:1/" });
  assert.equal(stillOnServer(c), false, "pointing the tab again is another server, even at the same address");
  assert.equal(stillOnServer(null), false);
  setConnection({});
});

test("each token, role or scope change is its own instance on the same server", () => {
  const first = setConnection({ serverUrl: "https://s.example/" });
  const seen = [first];
  for (const change of [{ token: "t" }, { role: "edit" }, { scope: "doc-1" }, { scope: "" }]) {
    seen.push(updateConnection(change));
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.every((c) => serverOf(c) === serverOf(first) && stillOnServer(c)));
  assert.notEqual(serverOf(setConnection({ serverUrl: "https://s.example/" })), serverOf(first));
  setConnection({});
});

test("a document is only ever saved through the connection it was opened through", () => {
  const a = setConnection({ serverUrl: "http://a:1/", token: "ta" });
  setHome("server", { id: "doc-a" });
  assert.throws(() => setConnection({ serverUrl: "http://b:2/" }), /leave it/);
  assert.equal(conn, a);
  assert.throws(() => updateConnection({ serverUrl: "http://b:2/" }), /not a field that moves/);
  assert.throws(() => updateConnection({ tunnel: null }), /belongs to the server/);
  setHome("none");
  const b = setConnection({ serverUrl: "http://b:2/" });
  assert.throws(() => setHome("server", { id: "doc-b", conn: a }), /this tab's connection/);
  assert.equal(setHome("server", { id: "doc-b", conn: b }).conn, b);
  setHome("none");
  setConnection({});
});

test("a link's scope is a document id the server could have named, kept like the role", () => {
  const c = setConnection({ serverUrl: "https://s.example/", token: "t" });
  assert.equal(c.scope, "");
  setHome("server", { id: "doc-7" });
  updateConnection({ role: "edit", scope: "doc-7" });
  assert.equal(home.conn.scope, "doc-7", "the home sees it without a second copy");
  assert.equal(home.conn, conn);
  assert.notEqual(conn, c);
  assert.throws(() => updateConnection({ scope: "../etc" }), /a scope is/);
  assert.throws(() => updateConnection({ scope: "Doc 7" }), /a scope is/);
  assert.throws(() => updateConnection({ scope: 7 }), /a scope is/);
  assert.equal(conn.scope, "doc-7", "a refused scope leaves the one there was");
  updateConnection({ scope: "" });
  assert.equal(conn.scope, "");
  setHome("none");
  setConnection({ serverUrl: "https://s.example/", token: "t", role: "review", scope: "doc-7" });
  assert.equal(setConnection({ serverUrl: "https://other.example/" }).scope, "");
  setConnection({});
});

test("restoreHome refuses a server home whose connection the tab has since left", () => {
  setConnection({ serverUrl: "http://a:1/" });
  const old = setHome("server", { id: "doc-a" });
  setHome("none");
  setConnection({ serverUrl: "http://b:2/" });
  assert.throws(() => restoreHome(old), /no longer has/);
  setConnection({});
});
