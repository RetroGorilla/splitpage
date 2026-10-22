import { test } from "node:test";
import assert from "node:assert/strict";
import { HOME_KINDS, createDocumentLocation } from "../../../src/application/location/document-location.ts";
import type { Home, LocationChange } from "../../../src/application/location/document-location.ts";
import { normalizeServerUrl } from "../../../shared/server-links.js";

test("a document starts out with nowhere to live", () => {
  const loc = createDocumentLocation();
  assert.deepEqual(loc.home(), { kind: "none" });
  assert.equal(loc.serverHomeId(), null);
  assert.equal(loc.serverHomeRev(), null);
  assert.equal(loc.fileHome(), null);
  assert.equal(loc.importHome(), null);
  assert.equal(loc.writtenOut(), false);
});

test("the four kinds are none, file, import and server", () => {
  assert.deepEqual(HOME_KINDS.slice().sort(), ["file", "import", "none", "server"]);
});

test("setHome builds a record with exactly its kind's fields, defaulted", () => {
  const loc = createDocumentLocation();
  const f = loc.setHome("file", { format: "md", name: "a.md" });
  assert.deepEqual(f, { kind: "file", handle: null, format: "md", name: "a.md",
                        lastModified: null, diskBase: null });
  const i = loc.setHome("import", { name: "notes.docx", format: "docx" });
  assert.deepEqual(i, { kind: "import", handle: null, format: "docx", name: "notes.docx",
                        lastModified: null, size: null, inPlace: false, dirty: false, diskBase: null });
  const s = loc.setHome("server", { id: "doc-1" });
  assert.deepEqual(s, { kind: "server", id: "doc-1", rev: 0, conn: loc.connection() });
  assert.equal(s["conn"], loc.connection(), "a server home holds this tab's connection itself, not a copy");
  assert.deepEqual(loc.setHome("none"), { kind: "none" });
});

test("readers see the current record", () => {
  const loc = createDocumentLocation();
  const rec = loc.setHome("server", { id: "doc-2", rev: 7 });
  assert.equal(loc.home(), rec);
  assert.equal(loc.home()["rev"], 7);
  assert.equal(loc.serverHomeId(), "doc-2");
  assert.equal(loc.serverHomeRev(), 7);
  loc.setHome("none");
  assert.equal(loc.home().kind, "none");
});

test("changing home replaces the record whole — two homes can never be half-set", () => {
  const loc = createDocumentLocation();
  const handle = { name: "script.md" };
  loc.setHome("file", { handle, format: "md", name: "script.md", lastModified: 5, diskBase: { rows: [] } });
  loc.setHome("server", { id: "doc-3", rev: 2 });
  assert.equal(loc.fileHome(), null);
  assert.equal(loc.importHome(), null);
  assert.equal("handle" in loc.home(), false);
  assert.equal("diskBase" in loc.home(), false);
  assert.equal("lastModified" in loc.home(), false);

  loc.setHome("import", { name: "a.docx", format: "docx", dirty: true });
  assert.equal(loc.serverHomeId(), null);
  assert.equal("id" in loc.home(), false);
  assert.equal("rev" in loc.home(), false);

  loc.setHome("file", { format: "splitpage", name: "b.splitpage" });
  assert.equal(loc.importHome(), null);
  assert.equal("dirty" in loc.home(), false);
  assert.equal(loc.home()["diskBase"], null, "a new file home starts with no ancestor of its own");
});

test("fileHome and importHome never hand one kind's handle to the other", () => {
  const loc = createDocumentLocation();
  const handle = { name: "report.docx" };
  loc.setHome("import", { handle, name: "report.docx", format: "docx" });
  assert.equal(loc.fileHome(), null, "Save must not pick up the import's handle");
  assert.equal(loc.importHome()?.["handle"], handle);
  loc.setHome("file", { handle, format: "md", name: "report.md" });
  assert.equal(loc.importHome(), null);
  assert.equal(loc.fileHome()?.["handle"], handle);
});

test("a field from another kind, or the old globals, throws where it is written", () => {
  const loc = createDocumentLocation();
  assert.throws(() => loc.setHome("file", { format: "md", name: "a.md", kind: "md" }), /format is `format`/);
  assert.throws(() => loc.setHome("file", { handle: null, kind: "md" }), /format is `format`/);
  assert.throws(() => loc.setHome("server", { id: "d", handle: null }), /server home has no field "handle"/);
  assert.throws(() => loc.setHome("none", { id: "d" }), /none home has no field "id"/);
  assert.throws(() => loc.setHome("file", { format: "md", lastModifed: 1 }), /no field "lastModifed"/);
  assert.throws(() => loc.setHome("drive", {}), /unknown kind "drive"/);
  assert.equal(loc.home().kind, "none", "a refused setHome leaves the home where it was");
});

test("a home that would mean nothing is refused rather than stored", () => {
  const loc = createDocumentLocation();
  assert.throws(() => loc.setHome("server", { id: null }), /needs "id"/);
  assert.throws(() => loc.setHome("server", {}), /needs "id"/);
  assert.throws(() => loc.setHome("file", { name: "a.md" }), /needs "format"/);
  assert.throws(() => loc.setHome("import", { format: "docx" }), /needs "name"/);
});

test("restoreHome puts back the same object, not a copy", () => {
  const loc = createDocumentLocation();
  const before = loc.setHome("import", { name: "a.csv", format: "csv" });
  const picked = loc.setHome("file", { format: "md", name: "a.md" });
  assert.notEqual(loc.home(), before);
  loc.restoreHome(before);
  assert.equal(loc.home(), before);
  assert.notEqual(loc.home(), picked);
  assert.throws(() => loc.restoreHome({ kind: "drive" } as unknown as Home), /not a home record/);
  assert.throws(() => loc.restoreHome(null as unknown as Home), /not a home record/);
  assert.throws(() => loc.restoreHome({ kind: "none" }), /not a home record/, "a record this owner did not make is refused");
});

test("the record's own facts move in place through amendHome while the home stays the same", () => {
  const loc = createDocumentLocation();
  const rec = loc.setHome("server", { id: "doc-4", rev: 1 });
  loc.amendHome(rec, { rev: 2 });
  assert.equal(rec["rev"], 2);
  assert.equal(loc.home(), rec);
  assert.equal(loc.serverHomeRev(), 2);
});

test("a home record refuses every write that does not go through the owner", () => {
  const loc = createDocumentLocation();
  const rec = loc.setHome("server", { id: "doc-5", rev: 1 }) as unknown as Record<string, unknown>;
  assert.throws(() => { rec["rev"] = 2; }, /through the document location owner/);
  assert.throws(() => { delete rec["rev"]; }, /through the document location owner/);
  assert.throws(() => Object.defineProperty(rec, "rev", { value: 3 }), /through the document location owner/);
  assert.equal(rec["rev"], 1, "a refused write leaves the record as it was");
});

test("amendHome changes only a kind's own changing facts", () => {
  const loc = createDocumentLocation();
  const file = loc.setHome("file", { format: "md", name: "a.md" });
  loc.amendHome(file, { diskBase: { rows: [] }, lastModified: 9 });
  assert.deepEqual(file["diskBase"], { rows: [] });
  assert.equal(file["lastModified"], 9);
  assert.throws(() => loc.amendHome(file, { name: "b.md" }), /"name" is set when the home is made/);
  assert.throws(() => loc.amendHome(file, { rev: 3 }), /"rev" is set when the home is made/);

  const imported = loc.setHome("import", { name: "a.docx", format: "docx" });
  loc.amendHome(imported, { dirty: true, inPlace: true, size: 12, lastModified: 4, diskBase: { rows: [] } });
  assert.deepEqual([imported["dirty"], imported["inPlace"], imported["size"], imported["lastModified"]], [true, true, 12, 4]);
  assert.throws(() => loc.amendHome(imported, { handle: {} }), /"handle" is set when the home is made/);

  const server = loc.setHome("server", { id: "doc-6" });
  assert.throws(() => loc.amendHome(server, { id: "doc-7" }), /"id" is set when the home is made/);
  assert.throws(() => loc.amendHome(server, { conn: null }), /"conn" is set when the home is made/);
  assert.throws(() => loc.amendHome({ kind: "server", rev: 0 }, { rev: 1 }), /not a home record/);
});

test("a record held across a change of home is still amended, without moving the current home", () => {
  const loc = createDocumentLocation();
  const held = loc.setHome("file", { format: "md", name: "a.md" });
  const next = loc.setHome("import", { name: "b.csv", format: "csv" });
  loc.amendHome(held, { lastModified: 5 });
  assert.equal(held["lastModified"], 5);
  assert.equal(loc.home(), next);
});

test("each change to the home, the connection or the written-out flag is announced", () => {
  const loc = createDocumentLocation();
  const seen: LocationChange[] = [];
  const stop = loc.onChange((change) => seen.push(change));
  const rec = loc.setHome("file", { format: "md", name: "a.md" });
  loc.amendHome(rec, { lastModified: 1 });
  loc.setConnection({ serverUrl: "http://a:1/" });
  loc.updateConnection({ token: "t" });
  loc.markWrittenOut(true);
  loc.markWrittenOut(true);
  const other = loc.setHome("none");
  loc.amendHome(rec, { lastModified: 2 });
  loc.restoreHome(rec);
  loc.restoreHome(other);
  stop();
  loc.setHome("none");
  assert.deepEqual(seen, ["home", "home", "connection", "connection", "writtenOut", "home", "home", "home"]);
  assert.equal(loc.writtenOut(), true);
});

test("a tab starts on its own origin's server, with nothing proved there", () => {
  const loc = createDocumentLocation();
  assert.deepEqual(loc.connection(), { serverUrl: "", token: "", role: "", scope: "", tunnel: null });
  assert.equal(loc.homeConn(), null);
});

test("server addresses are normalized one way", () => {
  assert.equal(normalizeServerUrl(""), "");
  assert.equal(normalizeServerUrl("  "), "");
  assert.equal(normalizeServerUrl("192.168.1.20:8791"), "http://192.168.1.20:8791/");
  assert.equal(normalizeServerUrl("https://studio.example.com///"), "https://studio.example.com/");
  assert.equal(normalizeServerUrl("http://a:1/"), "http://a:1/");
});

test("setConnection replaces the record whole and validates every field", () => {
  const loc = createDocumentLocation();
  const a = loc.setConnection({ serverUrl: "http://a:1/", token: "t1", role: "edit" });
  assert.equal(loc.connection(), a);
  assert.deepEqual(a, { serverUrl: "http://a:1/", token: "t1", role: "edit", scope: "", tunnel: null });
  const b = loc.setConnection({ serverUrl: "http://b:2/" });
  assert.notEqual(b, a);
  assert.deepEqual(b, { serverUrl: "http://b:2/", token: "", role: "", scope: "", tunnel: null });

  assert.throws(() => loc.setConnection({ serverUrl: "b:2" }), /not a normalized base/);
  assert.throws(() => loc.setConnection({ serverBase: "http://b:2/" }), /no field "serverBase"/);
  assert.throws(() => loc.setConnection({ role: "admin" }), /unknown role "admin"/);
  assert.throws(() => loc.setConnection({ token: 5 }), /a token is a string/);
  assert.equal(loc.connection(), b, "a refused setConnection leaves the connection where it was");
});

test("a tunnel is host and ports, and nothing that could carry a secret", () => {
  const loc = createDocumentLocation();
  const t = loc.setConnection({ serverUrl: "http://localhost:8899/",
    tunnel: { userHost: "me@studio.example.com", remotePort: 8791, localPort: 8899 } });
  assert.deepEqual(t.tunnel, { userHost: "me@studio.example.com", remotePort: 8791, localPort: 8899 });
  assert.throws(() => loc.setConnection({ tunnel: { userHost: "me@h", remotePort: 1, localPort: 2, password: "x" } }),
    /tunnel has no field "password"/);
  assert.throws(() => loc.setConnection({ tunnel: { userHost: "me@h -o ProxyCommand=x", remotePort: 1, localPort: 2 } }),
    /needs a userHost/);
  assert.throws(() => loc.setConnection({ tunnel: { userHost: "-oProxyCommand=x", remotePort: 1, localPort: 2 } }),
    /needs a userHost/);
  assert.throws(() => loc.setConnection({ tunnel: { userHost: "me@h", remotePort: 0, localPort: 2 } }), /ports/);
  assert.throws(() => loc.setConnection({ tunnel: "me@h" }), /a tunnel is null/);
});

test("a server home holds this tab's connection, and moves to the new one when a token arrives later", () => {
  const loc = createDocumentLocation();
  const c = loc.setConnection({ serverUrl: "http://a:1/" });
  const h = loc.setHome("server", { id: "doc-1", rev: 3 });
  assert.equal(h["conn"], c);
  assert.equal(loc.homeConn(), c);
  const next = loc.updateConnection({ token: "tok", role: "review" });
  assert.notEqual(next, c, "a token or role change is a new connection instance");
  assert.equal(loc.connection(), next);
  assert.equal(loc.home(), h, "the home is the same destination");
  assert.equal(loc.home()["conn"], next, "and it moved to the new connection");
  assert.equal(next.token, "tok");
  assert.equal(next.role, "review");
  assert.equal(c.token, "", "the old instance keeps what it had");
  assert.equal(c.role, "");
  assert.ok(Object.isFrozen(next), "an instance never changes once made");
  assert.equal(loc.stillOnServer(c), true, "the old instance is on the same server");
  loc.setHome("none");
  loc.setConnection({ serverUrl: "http://a:1/" });
  assert.equal(loc.stillOnServer(c), false, "pointing the tab again is another server, even at the same address");
  assert.equal(loc.stillOnServer(null), false);
});

test("each token, role or scope change is its own instance on the same server", () => {
  const loc = createDocumentLocation();
  const first = loc.setConnection({ serverUrl: "https://s.example/" });
  const seen = [first];
  for (const change of [{ token: "t" }, { role: "edit" }, { scope: "doc-1" }, { scope: "" }]) {
    seen.push(loc.updateConnection(change));
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(seen.every((c) => loc.serverOf(c) === loc.serverOf(first) && loc.stillOnServer(c)));
  assert.notEqual(loc.serverOf(loc.setConnection({ serverUrl: "https://s.example/" })), loc.serverOf(first));
});

test("a document is only ever saved through the connection it was opened through", () => {
  const loc = createDocumentLocation();
  const a = loc.setConnection({ serverUrl: "http://a:1/", token: "ta" });
  loc.setHome("server", { id: "doc-a" });
  assert.throws(() => loc.setConnection({ serverUrl: "http://b:2/" }), /leave it/);
  assert.equal(loc.connection(), a);
  assert.throws(() => loc.updateConnection({ serverUrl: "http://b:2/" }), /not a field that moves/);
  assert.throws(() => loc.updateConnection({ tunnel: null }), /belongs to the server/);
  loc.setHome("none");
  const b = loc.setConnection({ serverUrl: "http://b:2/" });
  assert.throws(() => loc.setHome("server", { id: "doc-b", conn: a }), /this tab's connection/);
  assert.equal(loc.setHome("server", { id: "doc-b", conn: b })["conn"], b);
});

test("a link's scope is a document id the server could have named, kept like the role", () => {
  const loc = createDocumentLocation();
  const c = loc.setConnection({ serverUrl: "https://s.example/", token: "t" });
  assert.equal(c.scope, "");
  loc.setHome("server", { id: "doc-7" });
  loc.updateConnection({ role: "edit", scope: "doc-7" });
  assert.equal((loc.home()["conn"] as { scope: string }).scope, "doc-7", "the home sees it without a second copy");
  assert.equal(loc.home()["conn"], loc.connection());
  assert.notEqual(loc.connection(), c);
  assert.throws(() => loc.updateConnection({ scope: "../etc" }), /a scope is/);
  assert.throws(() => loc.updateConnection({ scope: "Doc 7" }), /a scope is/);
  assert.throws(() => loc.updateConnection({ scope: 7 }), /a scope is/);
  assert.equal(loc.connection().scope, "doc-7", "a refused scope leaves the one there was");
  loc.updateConnection({ scope: "" });
  assert.equal(loc.connection().scope, "");
  loc.setHome("none");
  loc.setConnection({ serverUrl: "https://s.example/", token: "t", role: "review", scope: "doc-7" });
  assert.equal(loc.setConnection({ serverUrl: "https://other.example/" }).scope, "");
});

test("restoreHome refuses a server home whose connection the tab has since left", () => {
  const loc = createDocumentLocation();
  loc.setConnection({ serverUrl: "http://a:1/" });
  const old = loc.setHome("server", { id: "doc-a" });
  loc.setHome("none");
  loc.setConnection({ serverUrl: "http://b:2/" });
  assert.throws(() => loc.restoreHome(old), /no longer has/);
});

test("review mode follows the server home's connection, through the authority policy", () => {
  const loc = createDocumentLocation();
  assert.equal(loc.reviewMode(), false, "no server home is never review mode");
  loc.setConnection({ serverUrl: "https://s.example/", token: "t", role: "review", scope: "doc-1" });
  assert.equal(loc.reviewMode(), false, "a review connection with no document open is not review mode yet");
  loc.setHome("server", { id: "doc-1" });
  assert.equal(loc.reviewMode(), true);
  loc.updateConnection({ role: "edit" });
  assert.equal(loc.reviewMode(), false);
});
