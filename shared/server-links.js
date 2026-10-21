"use strict";

function parseLinkFragment(hash) {
  var h = String(hash || "");
  var m = /(^#|&)(invite|review)=([A-Za-z0-9_-]{1,256})(?=&|$)/.exec(h);
  if (!m) return null;
  var rest = h.slice(0, m.index) + m[1] + h.slice(m.index + m[0].length);
  rest = rest.replace(/^#&/, "#").replace(/&&/g, "&").replace(/&$/, "");
  if (rest === "#") rest = "";
  return { key: m[3], kind: m[2], rest: rest };
}

function tunnelCommand(t) {
  return "ssh -N -L " + t.localPort + ":localhost:" + t.remotePort + " " + t.userHost;
}

function joinErrorText(code) {
  if (code === "bad-pin") return "That code was not right. Ask whoever is hosting for it again.";
  if (code === "link-off") return "The owner turned off this link. Ask them for a new one.";
  if (code === "too-many-attempts") return "Too many wrong codes. Wait a minute, then try again.";
  if (code === "offline") return "No answer from that address. Check it, and that the session is still running.";
  if (code === "not-splitpage") return "Something answered, but it was not a Splitpage server.";
  return "Could not join: " + code + ".";
}

module.exports = {
  joinErrorText,
  parseLinkFragment,
  tunnelCommand
};
