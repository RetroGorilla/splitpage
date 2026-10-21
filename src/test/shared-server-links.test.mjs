import test from "node:test";
import assert from "node:assert/strict";
import { joinErrorText, parseLinkFragment, tunnelCommand } from "../../shared/server-links.js";

test("parseLinkFragment pulls an invite or review key out and keeps the rest of the fragment", () => {
  assert.deepEqual(parseLinkFragment("#invite=abc_123"), { key: "abc_123", kind: "invite", rest: "" });
  assert.deepEqual(parseLinkFragment("#review=K-1"), { key: "K-1", kind: "review", rest: "" });
  assert.deepEqual(parseLinkFragment("#x=1&invite=abc&y=2"), { key: "abc", kind: "invite", rest: "#x=1&y=2" });
  assert.deepEqual(parseLinkFragment("#invite=abc&y=2"), { key: "abc", kind: "invite", rest: "#y=2" });
  assert.deepEqual(parseLinkFragment("#y=2&review=abc"), { key: "abc", kind: "review", rest: "#y=2" });
});

test("parseLinkFragment returns null when there is no well-formed key", () => {
  for (const hash of ["", "#", "#invite=", "#invite=a b", "#xinvite=abc", "#invite=abc!", "#other=abc", null, undefined]) {
    assert.equal(parseLinkFragment(hash), null, String(hash));
  }
  assert.equal(parseLinkFragment("#invite=" + "a".repeat(257)), null);
  assert.equal(parseLinkFragment("#invite=" + "a".repeat(256)).key.length, 256);
});

test("tunnelCommand writes the ssh port-forward line for a bookmark", () => {
  assert.equal(tunnelCommand({ localPort: 8080, remotePort: 3000, userHost: "me@host" }), "ssh -N -L 8080:localhost:3000 me@host");
});

test("joinErrorText gives a plain sentence for each known join failure and echoes any other code", () => {
  assert.match(joinErrorText("bad-pin"), /code was not right/);
  assert.match(joinErrorText("link-off"), /turned off this link/);
  assert.match(joinErrorText("too-many-attempts"), /Too many wrong codes/);
  assert.match(joinErrorText("offline"), /No answer from that address/);
  assert.match(joinErrorText("not-splitpage"), /not a Splitpage server/);
  assert.equal(joinErrorText("HTTP 500"), "Could not join: HTTP 500.");
});
