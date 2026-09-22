/* This tab's connection (_home.js, #11).
 *
 * Which server a tab talks to used to be three loose globals in
 * 13-hosted.js plus two localStorage keys every tab of the origin shared, so
 * pointing one tab at another server re-pointed the next tab to load, and a
 * remembered token went to whichever server was current. What is pinned
 * here is the record that replaced them:
 *
 *   - `conn` starts as the same-origin server, with no token and no role,
 *     without a page and without any __init() (the leaf rule, #92);
 *   - setConnection() validates every field and throws on an unknown one,
 *     exactly as setHome() does;
 *   - a server home IS the tab's connection (identity), so a token or a role
 *     that arrives later through updateConnection() is seen by the home;
 *   - a tab cannot be pointed at another server while a server home holds
 *     the old connection, and a server home cannot be made with a connection
 *     that is not the tab's — a document is only ever saved through the
 *     connection it was opened through.
 *
 * The storage half (which key survives a reload, which is per server) is a
 * page's business and is driven by tests/59-per-tab-connection.txt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  conn,
  home,
  homeConn,
  normalizeServerUrl,
  restoreHome,
  setConnection,
  setHome,
  updateConnection
} from "../js/_home.js";

test("a tab starts on its own origin's server, with nothing proved there", () => {
  assert.deepEqual(conn, { serverUrl: "", token: "", role: "", tunnel: null });
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
  assert.deepEqual(a, { serverUrl: "http://a:1/", token: "t1", role: "edit", tunnel: null });
  /* nothing of the previous server survives a new one */
  const b = setConnection({ serverUrl: "http://b:2/" });
  assert.notEqual(b, a);
  assert.deepEqual(b, { serverUrl: "http://b:2/", token: "", role: "", tunnel: null });

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

test("a server home holds this tab's connection, and sees a token that arrives later", () => {
  const c = setConnection({ serverUrl: "http://a:1/" });
  const h = setHome("server", { id: "doc-1", rev: 3 });
  assert.equal(h.conn, c);
  assert.equal(homeConn(), c);
  /* the PIN typed after the document was asked for, and /api/me's answer */
  updateConnection({ token: "tok", role: "review" });
  assert.equal(home.conn.token, "tok");
  assert.equal(home.conn.role, "review");
  assert.equal(conn, c, "updateConnection moves a fact in place, it does not replace the record");
  setHome("none");
  setConnection({});
});

test("a document is only ever saved through the connection it was opened through", () => {
  const a = setConnection({ serverUrl: "http://a:1/", token: "ta" });
  setHome("server", { id: "doc-a" });
  /* pointing the tab elsewhere while the server home holds the old one */
  assert.throws(() => setConnection({ serverUrl: "http://b:2/" }), /leave it/);
  assert.equal(conn, a);
  /* the server is not a fact that moves in place either */
  assert.throws(() => updateConnection({ serverUrl: "http://b:2/" }), /not a field that moves/);
  assert.throws(() => updateConnection({ tunnel: null }), /belongs to the server/);
  /* leave the home first, then point the tab */
  setHome("none");
  const b = setConnection({ serverUrl: "http://b:2/" });
  /* and a server home cannot be handed some other connection */
  assert.throws(() => setHome("server", { id: "doc-b", conn: a }), /this tab's connection/);
  assert.equal(setHome("server", { id: "doc-b", conn: b }).conn, b);
  setHome("none");
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
