/* Collaborate's pure half (13b-collaborate.js): the link it builds, the
 * link a guest arrives on, and the server address Settings takes.
 *
 * The link is the whole of what a guest is given, so its shape is pinned
 * here: the server's own address, the script in `?doc=`, the key in the
 * fragment (which browsers never send to a server) — and nothing a
 * malformed key or an odd base could turn into something else. The other
 * end, parseLinkFragment(), is what 13-hosted.js reads the address with at
 * boot: an `#invite=` or an old `#review=` key, taken out of the fragment
 * with anything else there kept.
 *
 * The page half (the dialog, the steps, a guest arriving) is the browser
 * suites 260-264's.
 */
import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_COLLAB_SERVER,
  COLLAB_SERVER_KEY,
  inviteLink,
  normalizeCollabServer,
  parseLinkFragment,
  readCollabServer
} = await import("../js/13b-collaborate.js");

test("the built-in server is Adam's, over https, as a base", () => {
  assert.equal(DEFAULT_COLLAB_SERVER, "https://script.bigmanonline.uk/");
  assert.equal(normalizeCollabServer(DEFAULT_COLLAB_SERVER), DEFAULT_COLLAB_SERVER);
});

test("an address typed into Settings becomes a base, or nothing", () => {
  /* no scheme: https for a name, http for a LAN address */
  assert.equal(normalizeCollabServer("script.example.com"), "https://script.example.com/");
  assert.equal(normalizeCollabServer("  script.example.com/  "), "https://script.example.com/");
  assert.equal(normalizeCollabServer("192.168.1.20:8791"), "http://192.168.1.20:8791/");
  assert.equal(normalizeCollabServer("localhost:8791"), "http://localhost:8791/");
  /* a scheme is kept, the trailing slashes made one */
  assert.equal(normalizeCollabServer("http://studio.local:8791///"), "http://studio.local:8791/");
  assert.equal(normalizeCollabServer("HTTPS://Script.Example.com"), "https://script.example.com/");
  /* a path the server lives under is kept; a query, a fragment are not */
  assert.equal(normalizeCollabServer("https://example.com/splitpage/"), "https://example.com/splitpage/");
  assert.equal(normalizeCollabServer("https://example.com/?x=1#y"), "https://example.com/");
  /* nothing that is not an http(s) server */
  for (const bad of ["", "   ", "ftp://example.com/", "javascript:alert(1)", "file:///C:/x",
    "https://user:pass@example.com/", "https://", "not a url at all"]) {
    assert.equal(normalizeCollabServer(bad), "", bad);
  }
});

test("readCollabServer: the setting when it is one, else the built-in", () => {
  localStorage.removeItem(COLLAB_SERVER_KEY);
  assert.equal(readCollabServer(), DEFAULT_COLLAB_SERVER);
  localStorage.setItem(COLLAB_SERVER_KEY, "https://mine.example.com");
  assert.equal(readCollabServer(), "https://mine.example.com/");
  localStorage.setItem(COLLAB_SERVER_KEY, "javascript:alert(1)");
  assert.equal(readCollabServer(), DEFAULT_COLLAB_SERVER, "garbage in storage is the default, not an address");
  localStorage.removeItem(COLLAB_SERVER_KEY);
});

test("the link: the server's address, ?doc=, and the key in the fragment", () => {
  assert.equal(inviteLink("https://script.bigmanonline.uk/", "doc-1", "k3y_A-9"),
    "https://script.bigmanonline.uk/?doc=doc-1#invite=k3y_A-9");
  /* the page's own address (served by the server): its path kept, its
     query and fragment replaced */
  assert.equal(inviteLink("http://192.168.1.20:8791/index.html?doc=old#review=x", "doc-2", "abc"),
    "http://192.168.1.20:8791/index.html?doc=doc-2#invite=abc");
  /* an id is escaped, never pasted in */
  assert.equal(inviteLink("https://s.example/", "a b&c", "abc"), "https://s.example/?doc=a%20b%26c#invite=abc");
  /* nothing for a key that is not one, a missing document or a base that
     is not a web address a guest could open */
  assert.equal(inviteLink("https://s.example/", "doc-1", ""), "");
  assert.equal(inviteLink("https://s.example/", "doc-1", "a&b=c"), "");
  assert.equal(inviteLink("https://s.example/", "doc-1", "x".repeat(257)), "");
  assert.equal(inviteLink("https://s.example/", "", "abc"), "");
  assert.equal(inviteLink("splitpage://app/index.html", "doc-1", "abc"), "");
  assert.equal(inviteLink("not a url", "doc-1", "abc"), "");
});

test("the link a guest arrives on: #invite= or #review=, taken out, the rest kept", () => {
  assert.deepEqual(parseLinkFragment("#invite=abc123"), { key: "abc123", kind: "invite", rest: "" });
  assert.deepEqual(parseLinkFragment("#review=abc123"), { key: "abc123", kind: "review", rest: "" });
  assert.deepEqual(parseLinkFragment("#invite=a-b_C"), { key: "a-b_C", kind: "invite", rest: "" });
  /* anything else in the fragment stays */
  assert.deepEqual(parseLinkFragment("#launch=zz&invite=abc"), { key: "abc", kind: "invite", rest: "#launch=zz" });
  assert.deepEqual(parseLinkFragment("#invite=abc&launch=zz"), { key: "abc", kind: "invite", rest: "#launch=zz" });
  assert.deepEqual(parseLinkFragment("#a=1&invite=abc&b=2"), { key: "abc", kind: "invite", rest: "#a=1&b=2" });
  /* not a link: nothing taken */
  for (const none of ["", "#", "#collaborating", "#invite=", "#invites=abc", "#xinvite=abc",
    "#invite=a%20b", "#invite=a.b", "?invite=abc"]) {
    assert.equal(parseLinkFragment(none), null, none);
  }
  /* round trip: what inviteLink writes is what this reads */
  const link = inviteLink("https://s.example/", "doc-9", "Zz09_-");
  assert.equal(parseLinkFragment(new URL(link).hash).key, "Zz09_-");
});
