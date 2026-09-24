#!/usr/bin/env node
/* Behaviour tests for server/server.js — the join PIN, CORS, the
 * compare-and-set save, and the launcher's loopback-only route.
 *
 *   node tools/test-server.mjs
 *
 * The browser harness (.claude/skills/run-splitpage-app) serves static files
 * itself and cannot start server.js with an environment, so everything that
 * depends on JOIN_PIN / ALLOW_ORIGINS / LAUNCH_TOKEN is tested here instead:
 * plain Node, no dependencies, starts real servers on free ports and talks to
 * them over HTTP. Exits non-zero on the first failure's suite.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server", "server.js");

const PIN = "1234";
const ORIGIN = "http://example.test";
const LAUNCH = "abc";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, actual === expected, "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(env) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "splitpage-test-"));
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      STATIC_DIR: ROOT,
      NO_API: "0",
      ...env
    }
  });
  let log = "";
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });

  const base = "http://127.0.0.1:" + port + "/";
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(base + "api/health");
      if (res.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    port,
    /* the documents on disk, for the tests that care what a stored file
       actually looks like */
    dataDir,
    stop() {
      child.kill();
      rmSync(dataDir, { recursive: true, force: true });
    },
    get log() { return log; }
  };
}

async function json(res) {
  try { return await res.json(); } catch { return null; }
}

/* A request that announces a document-sized body and then sends twenty bytes
   of it and stops, without ever ending the message. fetch() cannot express
   that, so this is node:http directly.

   It is the whole proof for "the token is checked before the body is read"
   (#74): a server that reads first cannot answer this at all — it is still
   waiting for 25 MB that will never arrive — so an answer here IS the
   ordering. */
function refuseBeforeBody(base, pathname, method, headers) {
  return new Promise((resolve) => {
    const url = new URL(pathname, base);
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { req.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: Object.assign({
        "Content-Type": "application/json",
        "Content-Length": String(20 * 1024 * 1024)
      }, headers || {})
    }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      const end = () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        finish({ status: res.statusCode, body, closed: res.headers.connection === "close" });
      };
      res.on("end", end);
      res.on("close", end);
      res.on("aborted", end);
    });
    req.on("error", (err) => finish({ status: 0, error: String(err && err.message) }));
    req.write('{"baseRev":0,"state":{'); /* deliberately unfinished */
    timer = setTimeout(() => finish({ status: 0, error: "no answer — the body was read first" }), 5000);
  });
}

/* ---------- the PIN-protected server ---------- */

const s = await startServer({
  JOIN_PIN: PIN,
  ALLOW_ORIGINS: ORIGIN,
  LAUNCH_TOKEN: LAUNCH,
  HOST: "127.0.0.1"
});

try {
  /* health is open, and says a PIN is needed */
  {
    const res = await fetch(s.base + "api/health");
    const body = await json(res);
    eq("health answers 200 without a token", res.status, 200);
    eq("health says authRequired", body && body.authRequired, true);
    check("health carries a version", !!(body && body.version), JSON.stringify(body));
  }

  /* the gate */
  {
    const res = await fetch(s.base + "api/docs");
    const body = await json(res);
    eq("docs without a token is 401", res.status, 401);
    eq("...and says pin-required", body && body.error, "pin-required");
    check("...as JSON, so the client does not mistake it for a lapsed Access session",
      (res.headers.get("content-type") || "").includes("application/json"));
  }
  {
    const res = await fetch(s.base + "api/me");
    eq("/api/me is behind the gate too", res.status, 401);
  }

  /* wrong PIN, then the rate limit, then the right one */
  {
    const res = await fetch(s.base + "api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "0000" })
    });
    const body = await json(res);
    eq("a wrong PIN is 401", res.status, 401);
    eq("...and says bad-pin", body && body.error, "bad-pin");
  }
  {
    let last = null;
    for (let i = 0; i < 10; i++) {
      last = await fetch(s.base + "api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "0000" })
      });
    }
    const body = await json(last);
    eq("the 11th wrong PIN in a minute is 429", last.status, 429);
    eq("...and says too-many-attempts", body && body.error, "too-many-attempts");
  }

  /* The limiter is per address and this test has only one, so it has to be
     let go before the right PIN can be tried. A minute is too long to wait in
     a test — restart instead, which is also proof the token is per process. */
  s.stop();
} finally { /* stopped above; guard against an early throw */ }

const s2 = await startServer({
  JOIN_PIN: PIN,
  ALLOW_ORIGINS: ORIGIN + ",null",
  LAUNCH_TOKEN: LAUNCH,
  HOST: "127.0.0.1"
});

let token;
try {
  {
    const res = await fetch(s2.base + "api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: PIN })
    });
    const body = await json(res);
    eq("the right PIN is 200", res.status, 200);
    check("...and hands back a token", !!(body && typeof body.token === "string" && body.token.length === 64));
    token = body && body.token;
  }
  {
    const res = await fetch(s2.base + "api/docs", { headers: { "x-splitpage-token": token } });
    const body = await json(res);
    eq("docs with the token is 200", res.status, 200);
    check("...and lists documents", !!(body && Array.isArray(body.docs)));
  }

  /* CORS */
  {
    const res = await fetch(s2.base + "api/docs", {
      method: "OPTIONS",
      headers: { "Origin": ORIGIN, "Access-Control-Request-Method": "PUT" }
    });
    eq("a preflight from an allowed origin is 204", res.status, 204);
    eq("...echoes that origin", res.headers.get("access-control-allow-origin"), ORIGIN);
    eq("...varies on Origin", res.headers.get("vary"), "Origin");
    check("...allows the token header",
      (res.headers.get("access-control-allow-headers") || "").includes("x-splitpage-token"));
    check("...allows PUT", (res.headers.get("access-control-allow-methods") || "").includes("PUT"));
    check("...and PATCH, which the comment resolve route needs (#71)",
      (res.headers.get("access-control-allow-methods") || "").includes("PATCH"));
    eq("...and never allows credentials", res.headers.get("access-control-allow-credentials"), null);
  }
  {
    const res = await fetch(s2.base + "api/docs", {
      method: "OPTIONS",
      headers: { "Origin": "http://evil.test", "Access-Control-Request-Method": "PUT" }
    });
    eq("a preflight from any other origin gets no allow header",
      res.headers.get("access-control-allow-origin"), null);
  }
  {
    /* `null` is not one site: it is what every sandboxed iframe on the web
       sends, so it is dropped from the allowlist rather than honoured (#63).
       s2 is started with it in ALLOW_ORIGINS on purpose. */
    const res = await fetch(s2.base + "api/health", { headers: { "Origin": "null" } });
    eq("the literal origin `null` is never allowed, whatever ALLOW_ORIGINS says",
      res.headers.get("access-control-allow-origin"), null);
  }
  {
    const res = await fetch(s2.base + "index.html", { headers: { "Origin": ORIGIN } });
    eq("static files never carry CORS headers", res.headers.get("access-control-allow-origin"), null);
  }

  /* the compare-and-set save, unchanged by any of the above */
  {
    const created = await fetch(s2.base + "api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-splitpage-token": token },
      body: JSON.stringify({ state: { title: "Conflict test", rows: [] } })
    });
    const doc = await json(created);
    eq("a document can be created", created.status, 201);

    const ok = await fetch(s2.base + "api/docs/" + doc.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-splitpage-token": token },
      body: JSON.stringify({ baseRev: doc.rev, state: { title: "Conflict test", rows: [] } })
    });
    const okBody = await json(ok);
    eq("a save against the current rev is 200", ok.status, 200);
    eq("...and bumps the rev", okBody && okBody.rev, doc.rev + 1);

    const stale = await fetch(s2.base + "api/docs/" + doc.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-splitpage-token": token },
      body: JSON.stringify({ baseRev: doc.rev, state: { title: "Stale", rows: [] } })
    });
    const staleBody = await json(stale);
    eq("a save against a stale rev is still 409", stale.status, 409);
    eq("...saying conflict", staleBody && staleBody.error, "conflict");
    check("...and handing back their whole state to merge against",
      !!(staleBody && staleBody.state && staleBody.state.title === "Conflict test"));
  }

  /* the launcher's route. `info` is all that is left of it: `register` and
     `update/stage` both spawned a program #75 deleted, so both are gone and
     nothing under /api/launcher/ runs anything any more. What is still worth
     asserting is the gate, which is why the route was ever allowed to exist. */
  {
    const res = await fetch(s2.base + "api/launcher/info");
    eq("launcher/info without the launch header is 404", res.status, 404);
  }
  {
    const res = await fetch(s2.base + "api/launcher/info", { headers: { "x-splitpage-launch": "wrong" } });
    eq("launcher/info with the wrong launch token is 404", res.status, 404);
  }
  {
    const res = await fetch(s2.base + "api/launcher/info", { headers: { "x-splitpage-launch": LAUNCH } });
    const body = await json(res);
    eq("launcher/info with the launch token is 200", res.status, 200);
    check("...and names this folder", !!(body && body.root));
    check("...and what it is running on", !!(body && body.platform && body.arch));
  }
  {
    /* A verb that no longer exists is a 404 like any other — not a 500 from
       a half-removed route, and not a 200 with an error in it. */
    const res = await fetch(s2.base + "api/launcher/update/stage", {
      method: "POST", headers: { "x-splitpage-launch": LAUNCH }
    });
    eq("the staging route is gone, even with the launch token", res.status, 404);
  }
  {
    const res = await fetch(s2.base + "api/launcher/register", {
      method: "POST", headers: { "x-splitpage-launch": LAUNCH }
    });
    eq("...and so is register", res.status, 404);
  }
  {
    const res = await fetch(s2.base + "api/launcher/info", {
      headers: { "x-splitpage-launch": LAUNCH, "Origin": ORIGIN }
    });
    /* the header is allow-listed for preflight, but the route is loopback-only
       anyway — this is just proof the two features do not interact */
    eq("launcher/info still answers from an allowed origin", res.status, 200);
  }
} finally {
  s2.stop();
}

/* the same server, reachable from the network: the launcher's route is gone */
const s3 = await startServer({
  JOIN_PIN: PIN,
  LAUNCH_TOKEN: LAUNCH,
  HOST: "0.0.0.0"
});
try {
  const res = await fetch(s3.base + "api/launcher/info", { headers: { "x-splitpage-launch": LAUNCH } });
  eq("under --host, launcher/info is 404 even with the launch token", res.status, 404);
} finally {
  s3.stop();
}

/* ---------- the review credential (issue #30) ----------
 *
 * A second code, and a link key, that open the same documents to be read and
 * commented on. The interesting half is the PUT: the server has to accept a
 * whole document that differs from the stored one only by a comment and the
 * anchor that comment wrapped, and refuse everything else — so most of what
 * is below is one PUT per kind of change, against a known starting state.
 */

const REVIEW_PIN = "5678";
const REVIEW_KEY = "deadbeefdeadbeefdeadbeefdeadbeef";

function fixtureState() {
  return {
    title: "Review test",
    schema: 2,
    docId: "d" + "0".repeat(32),
    rev: 1,
    lastEditedBy: "Host",
    lastEditedAt: "2026-01-01T00:00:00.000Z",
    wordsPerMinute: 150,
    rows: [{
      id: "r1",
      visualText: "Wide <strong>shot</strong> of the kitchen",
      audioText: "Hello there",
      visualImage: null,
      status: "todo",
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "Host"
    }],
    comments: [{
      id: "c1", rowId: "r1", field: "audioText", anchorId: "c1",
      quotedText: "Hello", author: "Host", body: "does this read right?",
      resolved: false, kind: "anchor",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      replies: []
    }],
    people: [],
    productionTags: []
  };
}

function newComment(id, field, extra) {
  return Object.assign({
    id, rowId: "r1", field, anchorId: id, quotedText: "there",
    author: "Reviewer", body: "a note", resolved: false, kind: "anchor",
    createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z",
    replies: []
  }, extra || {});
}

const s4 = await startServer({
  JOIN_PIN: PIN,
  REVIEW_PIN,
  REVIEW_KEY,
  HOST: "127.0.0.1"
});

try {
  let editToken = null;
  let reviewToken = null;

  {
    const res = await fetch(s4.base + "api/health");
    const body = await json(res);
    eq("health says a review credential exists", body && body.reviewAvailable, true);
  }
  {
    const res = await fetch(s4.base + "api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: PIN })
    });
    const body = await json(res);
    eq("the join PIN still gives the editor role", body && body.role, "edit");
    editToken = body && body.token;
  }
  {
    const res = await fetch(s4.base + "api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: REVIEW_PIN })
    });
    const body = await json(res);
    eq("the review PIN is 200", res.status, 200);
    eq("...and gives the review role", body && body.role, "review");
    reviewToken = body && body.token;
    check("...with a token of its own, not the editor's", !!reviewToken && reviewToken !== editToken);
  }
  {
    const res = await fetch(s4.base + "api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: REVIEW_KEY })
    });
    const body = await json(res);
    eq("a review link's key joins as a reviewer too", body && body.role, "review");
    eq("...as the same session token", body && body.token, reviewToken);
  }
  {
    const res = await fetch(s4.base + "api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "0".repeat(32) })
    });
    eq("a wrong link key is refused like a wrong PIN", res.status, 401);
  }

  /* the role comes back from the token, which is what makes it survive a
     reconnect and makes it un-flippable from the client */
  {
    const mine = await json(await fetch(s4.base + "api/me", { headers: { "x-splitpage-token": reviewToken } }));
    eq("/api/me tells a reviewer what it is", mine && mine.role, "review");
    const theirs = await json(await fetch(s4.base + "api/me", { headers: { "x-splitpage-token": editToken } }));
    eq("...and an editor likewise", theirs && theirs.role, "edit");
  }
  /* create and delete are writes, and a review session has none */
  {
    const res = await fetch(s4.base + "api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-splitpage-token": reviewToken },
      body: JSON.stringify({ state: fixtureState() })
    });
    const body = await json(res);
    eq("a reviewer cannot create a document", res.status, 403);
    eq("...saying review-only", body && body.error, "review-only");
  }

  /* one document, created by the editor, for every PUT below */
  const created = await json(await fetch(s4.base + "api/docs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-splitpage-token": editToken },
    body: JSON.stringify({ state: fixtureState() })
  }));
  const docUrl = s4.base + "api/docs/" + created.id;

  /* ---- the review link is per document (#63) ----
     It used to be this launch's one key: it opened every script on the
     server and listed the picker, while the dialog offered it as a way to
     share the one you were looking at. */
  const other = await json(await fetch(s4.base + "api/docs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-splitpage-token": editToken },
    body: JSON.stringify({ state: Object.assign(fixtureState(), { title: "Another script" }) })
  }));

  let scopedKey = null, scopedToken = null;
  {
    const bare = await fetch(s4.base + "api/share", { headers: { "x-splitpage-token": editToken } });
    eq("share with no document to share is refused", bare.status, 400);
    const bogus = await fetch(s4.base + "api/share?doc=../etc", { headers: { "x-splitpage-token": editToken } });
    eq("...and so is an id that is not one", bogus.status, 400);
    const missing = await fetch(s4.base + "api/share?doc=nothing-here-0000", { headers: { "x-splitpage-token": editToken } });
    eq("...and a document that does not exist is 404", missing.status, 404);

    const res = await fetch(s4.base + "api/share?doc=" + created.id, { headers: { "x-splitpage-token": editToken } });
    const body = await json(res);
    eq("an editor can mint a review link for a document", res.status, 200);
    eq("...which names that document", body && body.docId, created.id);
    check("...and carries a key of its own, not this launch's",
      !!(body && body.reviewKey && body.reviewKey !== REVIEW_KEY));
    scopedKey = body && body.reviewKey;

    const again = await json(await fetch(s4.base + "api/share?doc=" + created.id, { headers: { "x-splitpage-token": editToken } }));
    eq("...the same key each time, so a link already sent keeps working",
      again && again.reviewKey, scopedKey);

    const asReviewer = await fetch(s4.base + "api/share?doc=" + created.id, { headers: { "x-splitpage-token": reviewToken } });
    eq("a reviewer cannot mint one — there is nothing for them to share", asReviewer.status, 403);
  }
  {
    const body = await json(await fetch(s4.base + "api/join", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: scopedKey })
    }));
    eq("a per-document key joins as a reviewer", body && body.role, "review");
    eq("...and says which document it is for", body && body.docId, created.id);
    check("...with a token of its own, not the launch-wide review token",
      !!(body && body.token && body.token !== reviewToken));
    scopedToken = body && body.token;
  }
  {
    const mine = await fetch(s4.base + "api/docs/" + created.id, { headers: { "x-splitpage-token": scopedToken } });
    eq("that token reads the document it was minted for", mine.status, 200);
    const theirs = await fetch(s4.base + "api/docs/" + other.id, { headers: { "x-splitpage-token": scopedToken } });
    const body = await json(theirs);
    eq("...and no other", theirs.status, 403);
    eq("...saying which rule refused it", body && body.error, "wrong-document");
    const gone = await fetch(s4.base + "api/docs/" + other.id, {
      method: "DELETE", headers: { "x-splitpage-token": scopedToken }
    });
    eq("...nor deletes one", gone.status, 403);
  }
  {
    const body = await json(await fetch(s4.base + "api/docs", { headers: { "x-splitpage-token": scopedToken } }));
    eq("the picker it can list is that one document", (body && body.docs || []).length, 1);
    eq("...and it is the right one", body && body.docs[0] && body.docs[0].id, created.id);
    const all = await json(await fetch(s4.base + "api/docs", { headers: { "x-splitpage-token": editToken } }));
    check("...while an editor still sees the library", (all && all.docs || []).length >= 2);
  }

  /* Read, change one thing, write — the round trip the review client used to
     make for every comment, and that the server used to judge by comparing
     the upload against the stored script (reviewWriteAllowed, deleted in
     #71). A review token now writes through the comment routes and nowhere
     else, so every one of these is refused — and refused FLAT, not by a
     verdict: the rev is read fresh each time, so a refusal below is never a
     stale rev conflicting, and nothing was compared to reach it. */
  async function reviewPut(mutate, token) {
    const now = await json(await fetch(docUrl, { headers: { "x-splitpage-token": token || reviewToken } }));
    const next = JSON.parse(JSON.stringify(now.state));
    mutate(next);
    const res = await fetch(docUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-splitpage-token": token || reviewToken },
      body: JSON.stringify({ baseRev: now.rev, state: next, by: "Reviewer" })
    });
    return { status: res.status, body: await json(res) };
  }
  /* The route the review client uses instead (#71). */
  async function reviewPost(url, payload, token) {
    const res = await fetch(url + "/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-splitpage-token": token || reviewToken },
      body: JSON.stringify(payload)
    });
    return { status: res.status, body: await json(res) };
  }
  const readAs = async (url, token) => await json(await fetch(url, { headers: { "x-splitpage-token": token || editToken } }));

  {
    const res = await fetch(docUrl, {
      method: "DELETE", headers: { "x-splitpage-token": reviewToken }
    });
    eq("a reviewer cannot delete a document", res.status, 403);
  }

  /* The write a review session exists for — a comment, plus the anchor it
     wrapped around the words it is about — is refused as a PUT, and lands
     through the comment route. */
  {
    const before = await readAs(docUrl);
    const out = await reviewPut((st) => {
      st.comments.push(newComment("c2", "audioText"));
      st.rows[0].audioText = 'Hello <span class="cmt-anchor" data-cmt="c2">there</span>';
      st.rows[0].updatedAt = "2026-02-01T00:00:00.000Z";
      st.rows[0].updatedBy = "Reviewer";
      st.rev = 2;
      st.lastEditedBy = "Reviewer";
    });
    eq("a review PUT is refused even when all it adds is a comment and its anchor", out.status, 403);
    eq("...refused as review-only", out.body && out.body.error, "review-only");
    check("...with no verdict attached, because nothing was compared", !(out.body && out.body.detail));
    const after = await readAs(docUrl);
    eq("...the rev did not move", after.rev, before.rev);
    check("...and nothing of it was written",
      !(after.state.comments || []).some((c) => c.id === "c2") && after.state.rows[0].audioText === "Hello there");
  }
  {
    const out = await reviewPost(docUrl, {
      comment: newComment("c2", "audioText"),
      anchor: { rowId: "r1", field: "audioText", html: 'Hello <span class="cmt-anchor" data-cmt="c2">there</span>' },
      by: "Reviewer"
    });
    eq("the same comment through the comment route lands", out.status, 200);
    eq("...with its anchor placed", out.body && out.body.anchored, true);
    const body = await readAs(docUrl, reviewToken);
    check("...and it is stored", !!(body && (body.state.comments || []).some((c) => c.id === "c2")));
  }
  {
    /* The stored state handed straight back. The old comparison passed this
       one; a flat refusal does not look. */
    const out = await reviewPut(() => {});
    eq("a review PUT that changes nothing at all is refused too", out.status, 403);
    eq("...as review-only", out.body && out.body.error, "review-only");
  }
  {
    /* And it is refused on the headers, before a byte of the body is read
       (#74): a review token cannot make the server buffer a 25 MB upload
       just to be told no. An answer at all is the proof. */
    const early = await refuseBeforeBody(s4.base, "api/docs/" + created.id, "PUT",
      { "x-splitpage-token": reviewToken });
    eq("a review PUT is refused before its body is read", early.status, 403, early.error);
    eq("...saying review-only", early.body && early.body.error, "review-only");
  }
  {
    /* The scoped token from the per-document link is a reviewer on this
       document like any other: the same PUT is refused, the same comment
       goes through the comment route. */
    const out = await reviewPut((st) => {
      st.comments.push(newComment("c2s", "audioText", { quotedText: "Hello" }));
      st.rows[0].audioText =
        '<span class="cmt-anchor" data-cmt="c2s">Hello</span>' +
        ' <span class="cmt-anchor" data-cmt="c2">there</span>';
    }, scopedToken);
    eq("a per-document reviewer's PUT to its own document is refused the same way", out.status, 403);
    eq("...as review-only", out.body && out.body.error, "review-only");
    const posted = await reviewPost(docUrl, {
      comment: newComment("c2s", "audioText", { quotedText: "Hello" }),
      /* wraps words that are already there, beside an anchor already stored */
      anchor: {
        rowId: "r1", field: "audioText",
        html: '<span class="cmt-anchor" data-cmt="c2s">Hello</span> <span class="cmt-anchor" data-cmt="c2">there</span>'
      }
    }, scopedToken);
    eq("...and comments on it through the comment route", posted.status, 200);
    eq("...anchored beside the anchor already there", posted.body && posted.body.anchored, true);
  }
  {
    /* A PUT to somebody else's document never reaches the role rule at
       all — the scope refuses it first. */
    const now = await json(await fetch(s4.base + "api/docs/" + other.id, { headers: { "x-splitpage-token": editToken } }));
    const res = await fetch(s4.base + "api/docs/" + other.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-splitpage-token": scopedToken },
      body: JSON.stringify({ baseRev: now.rev, state: now.state })
    });
    eq("...and cannot write to any other", res.status, 403);
    eq("...saying which rule refused it", (await json(res) || {}).error, "wrong-document");
  }

  /* ---- a document saved before a field existed (#62) ----
     The deleted comparison deep-compared the stored JSON key by key against
     the client's migrateRows()-normalised copy. A document last saved before
     `brollShots` existed has no such key; the reviewer's client always sent
     `brollShots: []`, and every comment on such a document came back 403
     review-only. There is no comparison left to disagree: the PUT is
     refused because it is a review PUT, and the comment goes through the
     route that never sees the rest of the state. */
  {
    const legacy = fixtureState();
    delete legacy.brollShots;
    delete legacy.productionTags;
    delete legacy.rows[0].updatedBy;
    const madeRes = await fetch(s4.base + "api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-splitpage-token": editToken },
      body: JSON.stringify({ state: legacy })
    });
    const made = await json(madeRes);
    const legacyUrl = s4.base + "api/docs/" + made.id;
    const now = await json(await fetch(legacyUrl, { headers: { "x-splitpage-token": reviewToken } }));
    check("a document stored without brollShots really has none", !("brollShots" in now.state));

    /* exactly what the old reviewer's client sent: every field filled in by
       migrateRows, plus the one comment and its anchor */
    const next = JSON.parse(JSON.stringify(now.state));
    next.brollShots = [];
    next.productionTags = [];
    next.rows[0].updatedBy = null;
    next.comments.push(newComment("c-legacy", "audioText"));
    next.rows[0].audioText = 'Hello <span class="cmt-anchor" data-cmt="c-legacy">there</span>';
    next.rows[0].updatedAt = "2026-02-01T00:00:00.000Z";
    next.rows[0].updatedBy = "Reviewer";
    next.lastEditedBy = "Reviewer";
    const res = await fetch(legacyUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-splitpage-token": reviewToken },
      body: JSON.stringify({ baseRev: now.rev, state: next, by: "Reviewer" })
    });
    eq("a review PUT on a document saved before a field existed is refused like any other",
      res.status, 403);

    const posted = await reviewPost(legacyUrl, {
      comment: newComment("c-legacy", "audioText"),
      anchor: { rowId: "r1", field: "audioText", html: 'Hello <span class="cmt-anchor" data-cmt="c-legacy">there</span>' },
      by: "Reviewer"
    });
    eq("...while the comment route takes the comment", posted.status, 200, posted.body && posted.body.error);
    const back = await json(await fetch(legacyUrl, { headers: { "x-splitpage-token": reviewToken } }));
    check("...and it is stored",
      !!(back && (back.state.comments || []).some((c) => c.id === "c-legacy")));
    check("...without the field the document never had being written into it",
      !("brollShots" in back.state) && !("productionTags" in back.state));

    const armed = JSON.parse(JSON.stringify(back.state));
    armed.productionTags = [{ cat: "prop", name: "Kettle", owner: "", notes: "", status: "needed" }];
    const refused = await fetch(legacyUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-splitpage-token": reviewToken },
      body: JSON.stringify({ baseRev: back.rev, state: armed, by: "Reviewer" })
    });
    eq("...and filling an empty field with something is refused", refused.status, 403);
  }

  /* ---- the anchor check that survived (#71) ----
     placeAnchor() still has to decide whether one field's new HTML is the
     stored field with this comment's span around some of it, and it uses
     the one piece of the old comparison kept for exactly that
     (fieldSignature over htmlTokens). These are the cases it exists for. */
  {
    /* an anchor whose selection crossed a <strong> boundary: unwrapping it
       cannot glue the element back together, so the comparison has to see
       the two halves as the one run of text they render as */
    const out = await reviewPost(docUrl, {
      comment: newComment("c3", "visualText", { quotedText: "shot of" }),
      anchor: {
        rowId: "r1", field: "visualText",
        html: 'Wide <strong></strong><span class="cmt-anchor" data-cmt="c3"><strong>shot</strong> of</span> the kitchen'
      }
    });
    eq("an anchor that split a <strong> in two is still only an anchor", out.status, 200);
    eq("...and is placed", out.body && out.body.anchored, true);
  }
  {
    /* Only THIS comment's span is unwrapped before comparing. Another id's
       span wrapped around a word that is not stored is new text, and the
       anchor is not placed (the comment itself still lands). */
    const stored = (await readAs(docUrl)).state.rows[0].audioText;
    const out = await reviewPost(docUrl, {
      comment: newComment("c4", "audioText"),
      anchor: {
        rowId: "r1", field: "audioText",
        html: stored + ' <span class="cmt-anchor" data-cmt="c9">again</span>'
      }
    });
    eq("an anchor that smuggles in another comment's span is not placed", out.body && out.body.anchored, false);
    eq("...though the comment still lands", out.status, 200);
    eq("...and the scene is exactly as it was", (await readAs(docUrl)).state.rows[0].audioText, stored);
  }

  /* And everything a review session never could do. Each of these changes
     exactly one thing about the document as it stands at that moment. They
     are refused flat now rather than by a comparison, and kept so that
     anything which ever lets a review PUT through again has to come past
     every one of them. */
  const refusals = [
    ["the script itself", (st) => { st.rows[0].audioText = "Hello there, everyone"; }],
    ["a scene's status", (st) => { st.rows[0].status = "shot"; }],
    ["the title", (st) => { st.title = "Renamed by a reviewer"; }],
    ["the reading speed", (st) => { st.wordsPerMinute = 200; }],
    ["a new scene", (st) => { st.rows.push({ id: "r2", visualText: "", audioText: "", visualImage: null, status: "todo" }); }],
    ["a deleted scene", (st) => { st.rows.length = 0; }],
    ["the production registry", (st) => { st.productionTags.push({ cat: "prop", name: "Ladder", owner: "", notes: "", status: "needed" }); }],
    ["a scene restamped with no comment on it", (st) => { st.rows[0].updatedBy = "Nobody At All"; }],
    ["someone else's comment", (st) => { st.comments[0].body = "rewritten"; }],
    ["a comment resolved", (st) => { st.comments[0].resolved = true; }],
    ["a comment deleted", (st) => { st.comments.length = 0; }],
    ["an anchor for a comment that is not new", (st) => {
      st.rows[0].audioText = st.rows[0].audioText + ' <span class="cmt-anchor" data-cmt="c9">again</span>';
      st.comments.push(newComment("c4", "audioText"));
    }],
    ["an anchor left behind with its comment removed", (st) => {
      st.comments = st.comments.filter((c) => c.id !== "c2");
    }]
  ];
  for (const [what, mutate] of refusals) {
    const out = await reviewPut(mutate);
    eq("a reviewer may not change " + what, out.status, 403);
    eq("...refused as review-only", out.body && out.body.error, "review-only");
  }
  /* A reply is an addition, which the old comparison allowed through PUT.
     It is refused there now and goes through the comment route. */
  {
    const out = await reviewPut((st) => {
      st.comments[0].replies.push({ id: "rp1", author: "Reviewer", body: "agreed", createdAt: "2026-02-01T00:00:02.000Z" });
      st.comments[0].updatedAt = "2026-02-01T00:00:02.000Z";
    });
    eq("a reply sent as a review PUT is refused", out.status, 403);
    const posted = await reviewPost(docUrl, {
      replyTo: "c1", reply: { id: "rp1", author: "Reviewer", body: "agreed" }
    });
    eq("...and a reviewer replies through the comment route", posted.status, 200);
  }
  /* and the editor is untouched by all of it: an editor's PUT is written
     as sent, comments and script alike, with nothing compared */
  {
    const out = await reviewPut((st) => {
      st.rows[0].audioText = "Hello there, everyone";
      st.comments[0].body = "the editor rewrote their own question";
    }, editToken);
    eq("the editor can still change the script", out.status, 200);
    const now = await readAs(docUrl);
    eq("...and a comment, in the same PUT", now.state.comments[0].body, "the editor rewrote their own question");
  }
} finally {
  s4.stop();
}

/* A review code that is the join PIN, or one with no join PIN at all, locks
   nothing — both are ignored rather than half-applied. */
const s5 = await startServer({ JOIN_PIN: PIN, REVIEW_PIN: PIN, HOST: "127.0.0.1" });
try {
  const res = await fetch(s5.base + "api/health");
  eq("a review PIN equal to the join PIN is not a review credential",
    (await json(res)).reviewAvailable, false);
  const joined = await json(await fetch(s5.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN })
  }));
  eq("...and those digits are still the editor's", joined && joined.role, "edit");
} finally {
  s5.stop();
}

const s6 = await startServer({ REVIEW_PIN, REVIEW_KEY, HOST: "127.0.0.1" });
try {
  const res = await fetch(s6.base + "api/health");
  const body = await json(res);
  eq("without a join PIN there is no review credential either", body && body.reviewAvailable, false);
  const joined = await json(await fetch(s6.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: REVIEW_PIN })
  }));
  eq("...an open server still hands out the editor token", joined && joined.role, "edit");
  check("...and says why it ignored the review code", s6.log.includes("review credential was IGNORED"), s6.log);
} finally {
  s6.stop();
}

/* ---------- presence (issue #28) ----------
 *
 * A heartbeat and a listing in one round trip, in memory, behind the same
 * gate. The TTL is dialled down here so the "a tab that went away stops being
 * shown" half can be watched rather than assumed.
 */

const s7 = await startServer({
  JOIN_PIN: PIN,
  REVIEW_PIN,
  REVIEW_KEY,
  HOST: "127.0.0.1",
  PRESENCE_TTL_MS: "400"
});

try {
  /* joinAs, not `join`: node:path's join() is imported at the top of this
     file and a local of that name shadowed it for the whole suite. */
  const joinAs = async (payload) => json(await fetch(s7.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
  const editToken = (await joinAs({ pin: PIN })).token;
  const reviewToken = (await joinAs({ pin: REVIEW_PIN })).token;

  const beat = (token, body) => fetch(s7.base + "api/presence", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" },
      token ? { "x-splitpage-token": token } : {}),
    body: JSON.stringify(body)
  });

  {
    const res = await beat(null, { docId: "shared-doc", id: "p1" });
    const body = await json(res);
    eq("presence without a token is 401", res.status, 401);
    eq("...saying pin-required, like every other route", body && body.error, "pin-required");
  }
  {
    const res = await beat(editToken, { docId: "../etc", id: "p1" });
    eq("a document id that is not one is refused", res.status, 400);
  }
  {
    const res = await beat(editToken, { docId: "shared-doc", id: "" });
    eq("a client with no id of its own is refused", res.status, 400);
  }
  {
    const res = await beat(editToken, { docId: "shared-doc", id: "p1", name: "Priya Malhotra", rowId: "r2", field: "audioText" });
    const body = await json(res);
    eq("the first person in a document is 200", res.status, 200);
    eq("...and is told about nobody, because they are alone", (body.here || []).length, 0);
  }
  {
    const body = await json(await beat(reviewToken, { docId: "shared-doc", id: "p2", name: "", rowId: "r2", field: "audioText" }));
    eq("a second person is told about the first", (body.here || []).length, 1);
    eq("...by name", body.here[0].name, "Priya Malhotra");
    eq("...and where they are", body.here[0].rowId + "/" + body.here[0].field, "r2/audioText");
    check("...and never about themselves", !body.here.some((p) => p.id === "p2"));
  }
  {
    /* A review viewer (#30) is someone else in the document like anybody
       else — and an anonymous one carries no name, which is what makes the
       other end say "Guest". */
    const body = await json(await beat(editToken, { docId: "shared-doc", id: "p1", name: "Priya Malhotra", rowId: "r1", field: "visualText" }));
    eq("an editor is told about the review viewer", (body.here || []).length, 1);
    eq("...with no name to show", body.here[0].name, "");
  }
  {
    const body = await json(await beat(editToken, { docId: "other-doc", id: "p1" }));
    eq("presence is per document", (body.here || []).length, 0);
  }
  {
    const body = await json(await beat(editToken, { docId: "shared-doc", id: "p3", field: "nonsense", rowId: "r1" }));
    check("a field that is not a field is dropped rather than echoed",
      body.here.every((p) => p.field !== "nonsense"));
  }
  {
    /* A picked colour (#194) is passed on as "#RRGGBB" and nothing else:
       it lands in another browser's style attribute. */
    await beat(editToken, { docId: "shared-doc", id: "p4", name: "Ana", color: "#80bdfb" });
    await beat(editToken, { docId: "shared-doc", id: "p5", name: "Bo", color: "red;background:url(x)" });
    const body = await json(await beat(editToken, { docId: "shared-doc", id: "p3" }));
    const ana = body.here.find((p) => p.id === "p4");
    const bo = body.here.find((p) => p.id === "p5");
    eq("a picked colour is passed on, upper-cased", ana && ana.color, "#80BDFB");
    check("...and anything that is not a colour is not passed on at all", !!bo && !("color" in bo));
    check("...nor is a colour nobody sent", body.here.filter((p) => p.id === "p1").every((p) => !("color" in p)));
  }
  {
    /* The beacon a closing tab sends: sendBeacon cannot set a header, so the
       token comes in the body, and text/plain is what a beacon may use. */
    const res = await fetch(s7.base + "api/presence", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ docId: "shared-doc", id: "p2", gone: true, token: reviewToken })
    });
    eq("a leaving beacon with the token in its body is accepted", res.status, 200);
    const body = await json(await beat(editToken, { docId: "shared-doc", id: "p1" }));
    check("...and that tab is gone at once", !body.here.some((p) => p.id === "p2"), JSON.stringify(body));
  }
  {
    const res = await fetch(s7.base + "api/presence", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ docId: "shared-doc", id: "p9", gone: true, token: "not-a-token" })
    });
    eq("a beacon carrying a wrong token is refused", res.status, 401);
  }
  {
    /* p3 is still there from above and nothing has beaten since. */
    await new Promise((r) => setTimeout(r, 600));
    const body = await json(await beat(editToken, { docId: "shared-doc", id: "p1" }));
    eq("a tab that stopped beating expires", (body.here || []).length, 0);
  }
  {
    /* Presence is not part of the document and must never become part of
       one: a document that was beaten about all this time is byte for byte
       what the editor last saved. */
    const created = await json(await fetch(s7.base + "api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-splitpage-token": editToken },
      body: JSON.stringify({ state: { title: "Presence test", rows: [], comments: [] } })
    }));
    await beat(editToken, { docId: created.id, id: "p1", name: "Priya Malhotra", rowId: "r1", field: "audioText" });
    const doc = await json(await fetch(s7.base + "api/docs/" + created.id, { headers: { "x-splitpage-token": editToken } }));
    eq("presence never bumps a document's rev", doc.rev, created.rev);
    check("...and never appears in its state",
      JSON.stringify(doc.state).indexOf("presence") === -1 && JSON.stringify(doc.state).indexOf("Priya") === -1,
      JSON.stringify(doc.state));
  }

  /* ---------- the heartbeat is the pull channel (issue #69) ----------
   *
   * The beat is the only thing in hosted mode that round-trips on its own,
   * so it is also how a second editor learns that somebody saved: it names
   * the document and the rev it is at, and the client GETs and merges when
   * that number has moved past the one it holds. This is the wire half; what
   * the page does with the answer is tests/55-pull-merge.txt.
   */
  {
    const made = await json(await fetch(s7.base + "api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-splitpage-token": editToken },
      body: JSON.stringify({ state: { title: "Pull channel", rows: [{ id: "r1" }], comments: [] } })
    }));
    const first = await json(await beat(editToken, { docId: made.id, id: "pull1" }));
    eq("a beat names the document it is about", first.docId, made.id);
    eq("...and the rev that document is at", first.rev, made.rev);
    check("...beside the people, not instead of them", Array.isArray(first.here));

    const saved = await json(await fetch(s7.base + "api/docs/" + made.id, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-splitpage-token": editToken },
      body: JSON.stringify({ baseRev: made.rev, state: { title: "Pull channel", rows: [{ id: "r1", audioText: "theirs" }], comments: [] } })
    }));
    const after = await json(await beat(editToken, { docId: made.id, id: "pull2" }));
    eq("...and the number moves the moment somebody else saves", after.rev, saved.rev);
    check("...which is one past where it was", saved.rev === made.rev + 1, String(saved.rev));
  }
  {
    /* Presence is in memory and a document is on disk, and the two are not
       required to agree: somebody can be beating about a document that was
       never published. No rev is no pull channel, not a refusal. */
    const res = await beat(editToken, { docId: "never-published", id: "pull3" });
    const body = await json(res);
    eq("a beat about a document that is not here still answers", res.status, 200);
    eq("...with no rev to pull on", body.rev, null);
    eq("...and still names the document it was asked about", body.docId, "never-published");
  }
  {
    /* THE READ IS THE HEAD LINE AND NOT THE SCRIPT (#74's whole point, and
       the reason this can run every two seconds for every tab). Proved by a
       file whose head line is perfectly good and whose state is not JSON at
       all: anything that parsed the document to answer a beat would throw,
       and a GET of the same file duly does. */
    writeFileSync(join(s7.dataDir, "head-only.json"),
      JSON.stringify({
        id: "head-only", rev: 9,
        updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "Host",
        title: "Head only", rows: 2
      }).slice(0, -1) + ',\n"state": this is not json at all}');

    const body = await json(await beat(editToken, { docId: "head-only", id: "pull4" }));
    eq("a beat reads the head line rather than parsing the document", body.rev, 9);
    const read = await fetch(s7.base + "api/docs/head-only", { headers: { "x-splitpage-token": editToken } });
    eq("...which is a document a full parse cannot read at all", read.status, 500);
  }
  {
    /* A closing tab's beacon is the one beat that touches no disk: it is not
       there to read an answer, so it is not given one. */
    const res = await fetch(s7.base + "api/presence", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ docId: "head-only", id: "pull4", gone: true, token: editToken })
    });
    const body = await json(res);
    eq("a leaving beacon is answered without a rev", body.rev, undefined);
    eq("...and is still just an acknowledgement", body.ok, true);
  }
} finally {
  s7.stop();
}

/* An open server (no PIN at all) has no gate to pass, and presence works
   there like everything else does. */
const s8 = await startServer({ HOST: "127.0.0.1" });
try {
  const res = await fetch(s8.base + "api/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId: "open-doc", id: "p1", name: "Sam" })
  });
  eq("presence on a server with no PIN needs no token", res.status, 200);
} finally {
  s8.stop();
}

/* ---------- the PIN rate limit behind a proxy (issue #74) ----------
 *
 * The limiter counts failures per address, and behind cloudflared, a reverse
 * proxy or Docker NAT every request arrives from the same one — so one
 * stranger's ten wrong guesses used to lock out everybody in the house.
 * TRUST_PROXY=1 says a proxy in front is rewriting the source address and
 * that X-Forwarded-For is worth reading. Off by default, because the header
 * is otherwise anybody's to write.
 */

const guess = (server, headers) => fetch(server.base + "api/join", {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
  body: JSON.stringify({ pin: "0000" })
});

const sProxyOff = await startServer({ JOIN_PIN: PIN, HOST: "127.0.0.1" });
try {
  for (let i = 0; i < 10; i++) await guess(sProxyOff, { "X-Forwarded-For": "1.1.1.1" });
  const same = await guess(sProxyOff, { "X-Forwarded-For": "1.1.1.1" });
  eq("without TRUST_PROXY, ten wrong guesses still run the address out", same.status, 429);
  const other = await guess(sProxyOff, { "X-Forwarded-For": "2.2.2.2" });
  eq("...and X-Forwarded-For buys a guesser nothing, because it is not trusted",
    other.status, 429);
} finally {
  sProxyOff.stop();
}

const sProxyOn = await startServer({ JOIN_PIN: PIN, HOST: "127.0.0.1", TRUST_PROXY: "1" });
try {
  check("the server says it is counting the header", sProxyOn.log.includes("TRUST_PROXY=1"), sProxyOn.log);
  {
    let last = null;
    for (let i = 0; i < 10; i++) last = await guess(sProxyOn, { "X-Forwarded-For": "1.1.1.1" });
    eq("with TRUST_PROXY, the tenth wrong guess from one client is still just wrong", last.status, 401);
    const again = await guess(sProxyOn, { "X-Forwarded-For": "1.1.1.1" });
    eq("...the eleventh is 429", again.status, 429);
  }
  {
    const other = await guess(sProxyOn, { "X-Forwarded-For": "2.2.2.2" });
    eq("...and the person at the next desk still gets their own ten", other.status, 401);
  }
  {
    /* A proxy appends: "the client, then whoever forwarded it". The first
       entry is the only one the client did not choose. */
    const chain = await guess(sProxyOn, { "X-Forwarded-For": "1.1.1.1, 9.9.9.9" });
    eq("a forwarded chain is keyed on its first entry, not its last", chain.status, 429);
    const spoofed = await guess(sProxyOn, { "X-Forwarded-For": "2.2.2.2, 1.1.1.1" });
    eq("...so a guesser cannot hide behind one it appended", spoofed.status, 401);
  }
  {
    /* Junk is not an address and must not become a bucket of its own —
       otherwise a guesser writes a new one on every attempt. It falls back
       to the socket, which is what these ten fill. */
    for (let i = 0; i < 10; i++) await guess(sProxyOn, { "X-Forwarded-For": "not an address" });
    const junk = await guess(sProxyOn, { "X-Forwarded-For": "still not an address" });
    eq("an unparseable X-Forwarded-For is ignored rather than trusted", junk.status, 429);
    const bare = await guess(sProxyOn);
    eq("...and it counted against the socket, like a request with no header at all", bare.status, 429);
  }
} finally {
  sProxyOn.stop();
}

/* ---------- the token, before the body (issue #74) ----------
 *
 * Every gated route used to be reachable by an unauthenticated caller for as
 * long as it took them to upload 25 MB, which was then parsed and thrown
 * away with a 401. The refusal happens on the headers now — see
 * refuseBeforeBody() above for why an answer at all is the proof.
 */

const sEarly = await startServer({ JOIN_PIN: PIN, HOST: "127.0.0.1" });
try {
  const token = (await json(await fetch(sEarly.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN })
  }))).token;
  const made = await json(await fetch(sEarly.base + "api/docs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-splitpage-token": token },
    body: JSON.stringify({ state: { title: "Early refusal", rows: [] } })
  }));

  {
    const out = await refuseBeforeBody(sEarly.base, "api/docs/" + made.id, "PUT");
    eq("a save with no token is refused before its body is read", out.status, 401, out.error);
    eq("...saying pin-required", out.body && out.body.error, "pin-required");
    check("...and the connection is closed, so the rest of the upload is not left in front of the next request",
      out.closed === true);
  }
  {
    const out = await refuseBeforeBody(sEarly.base, "api/docs/" + made.id, "PUT",
      { "x-splitpage-token": "0".repeat(64) });
    eq("a save with a wrong token likewise", out.status, 401, out.error);
  }
  {
    const out = await refuseBeforeBody(sEarly.base, "api/docs", "POST");
    eq("so is a create", out.status, 401, out.error);
  }
  {
    /* Presence is the route the issue named: it reads a body before the gate
       on purpose, because a closing tab's sendBeacon cannot set a header. A
       caller who did offer a header and got it wrong is refused first. */
    const out = await refuseBeforeBody(sEarly.base, "api/presence", "POST",
      { "x-splitpage-token": "0".repeat(64) });
    eq("presence with a wrong token header is refused before its body", out.status, 401, out.error);
  }
  {
    /* And the beacon, which has no header to be judged on, is capped instead:
       a heartbeat is a few hundred bytes and nothing unauthenticated gets to
       send a document. */
    const res = await fetch(sEarly.base + "api/presence", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ docId: "big-doc", id: "p1", filler: "x".repeat(32 * 1024) })
    });
    eq("an unauthenticated body bigger than a heartbeat is refused, not buffered", res.status, 413);
  }
  {
    const res = await fetch(sEarly.base + "api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-splitpage-token": token },
      body: JSON.stringify({ docId: "small-doc", id: "p1", name: "Sam" })
    });
    eq("...while a real heartbeat is unaffected", res.status, 200);
  }
  {
    const res = await fetch(sEarly.base + "api/docs", { headers: { "x-splitpage-token": token } });
    eq("and a plain GET is still answered on a connection that stays open", res.status, 200);
    eq("...with no Connection: close", res.headers.get("connection"), "keep-alive");
  }
} finally {
  sEarly.stop();
}

/* ---------- the head line (issue #74) ----------
 *
 * A stored document carries its own summary on its first line, so the rev a
 * PUT compares against and the names the picker lists can be read without
 * parsing every script in the library in full. It is in the file rather than
 * in a sidecar beside it, so a crash cannot leave the two disagreeing, and
 * the file is still one JSON object.
 */

function firstLine(path) {
  return readFileSync(path, "utf8").split("\n")[0];
}

function headOfFile(path) {
  const line = firstLine(path);
  return JSON.parse(line.replace(/,$/, "") + "}");
}

const sHead = await startServer({ JOIN_PIN: PIN, HOST: "127.0.0.1" });
try {
  const token = (await json(await fetch(sHead.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN })
  }))).token;
  const auth = { "Content-Type": "application/json", "x-splitpage-token": token };

  const made = await json(await fetch(sHead.base + "api/docs", {
    method: "POST", headers: auth,
    body: JSON.stringify({ state: { title: "Head line", rows: [{ id: "r1" }, { id: "r2" }] } })
  }));
  const file = join(sHead.dataDir, made.id + ".json");

  {
    const head = headOfFile(file);
    eq("a stored document names its rev on its first line", head.rev, 1);
    eq("...its title", head.title, "Head line");
    eq("...how many scenes it has", head.rows, 2);
    check("...and when it was last written", typeof head.updatedAt === "string");
    check("the file is still one JSON object",
      JSON.parse(readFileSync(file, "utf8")).state.title === "Head line");
  }
  {
    const res = await fetch(sHead.base + "api/docs/" + made.id, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ baseRev: 1, state: { title: "Head line, saved", rows: [{ id: "r1" }] } })
    });
    eq("a save against the rev on that line is 200", res.status, 200);
    const head = headOfFile(file);
    eq("...and the line moves with the document", head.rev, 2);
    eq("...including the title", head.title, "Head line, saved");
    eq("...and the scene count", head.rows, 1);
    /* The write is a temp file, fsynced, renamed over the target, and then
       the directory is fsynced too — so what is left behind afterwards is
       the document and nothing else. */
    check("a save leaves no temp file behind",
      !readdirSync(sHead.dataDir).some((n) => n.endsWith(".tmp")),
      readdirSync(sHead.dataDir).join(", "));
  }

  /* ---- a document written before head lines existed ----
     One JSON object on one line, which is what every document on every
     server looked like until now. Nothing about it may break, and the rev a
     PUT compares against has to come from a full parse instead. */
  const legacy = (id, rev, title) => {
    writeFileSync(join(sHead.dataDir, id + ".json"), JSON.stringify({
      id,
      rev,
      state: { title, rows: [{ id: "r1", visualText: "", audioText: "" }], comments: [] },
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "Host"
    }));
    return join(sHead.dataDir, id + ".json");
  };

  {
    const path = legacy("legacy-put", 3, "Saved the old way");
    const read = await json(await fetch(sHead.base + "api/docs/legacy-put", { headers: auth }));
    eq("a document with no head line still reads", read && read.rev, 3);

    const stale = await fetch(sHead.base + "api/docs/legacy-put", {
      method: "PUT", headers: auth,
      body: JSON.stringify({ baseRev: 2, state: { title: "no", rows: [] } })
    });
    eq("...and its rev still decides a conflict", stale.status, 409);
    const staleBody = await json(stale);
    eq("...handing back the whole state to merge against", staleBody.state.title, "Saved the old way");

    const ok = await fetch(sHead.base + "api/docs/legacy-put", {
      method: "PUT", headers: auth,
      body: JSON.stringify({ baseRev: 3, state: { title: "Saved the new way", rows: [] } })
    });
    eq("a save against it is accepted", ok.status, 200);
    eq("...counting on from the rev it had", (await json(ok)).rev, 4);
    eq("...and it has a head line from now on", headOfFile(path).rev, 4);
  }
  {
    const path = legacy("legacy-list", 7, "Also saved the old way");
    const body = await json(await fetch(sHead.base + "api/docs", { headers: auth }));
    const row = (body.docs || []).find((d) => d.id === "legacy-list");
    check("the picker lists a document with no head line", !!row, JSON.stringify(body.docs));
    eq("...by its title", row && row.title, "Also saved the old way");
    eq("...at its rev", row && row.rev, 7);
    /* and the listing leaves it with a head line, so the next one is cheap.
       The rewrite is the same content under the same lock as any other
       write, and it happens behind the answer rather than delaying it. */
    let head = null;
    for (let i = 0; i < 40 && !head; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try { head = headOfFile(path); } catch { head = null; }
    }
    check("...and gives it one, so the next listing is cheap", !!head);
    eq("...without touching its rev", head && head.rev, 7);
    eq("...or what it says", head && head.title, "Also saved the old way");
    eq("...or when it was last written", head && head.updatedAt, "2026-01-01T00:00:00.000Z");
  }
} finally {
  sHead.stop();
}

/* A published read-only library is not the place to be quietly rewriting
   files, however good the reason. */
const sHeadRO = await startServer({ HOST: "127.0.0.1", READ_ONLY: "1" });
try {
  const path = join(sHeadRO.dataDir, "legacy-frozen.json");
  const before = JSON.stringify({
    id: "legacy-frozen", rev: 2,
    state: { title: "Frozen", rows: [] },
    updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "Host"
  });
  writeFileSync(path, before);
  const body = await json(await fetch(sHeadRO.base + "api/docs"));
  const row = (body.docs || []).find((d) => d.id === "legacy-frozen");
  eq("a read-only library lists a document with no head line", row && row.title, "Frozen");
  await new Promise((r) => setTimeout(r, 300));
  eq("...and does not write one", readFileSync(path, "utf8"), before);
} finally {
  sHeadRO.stop();
}

/* ---------- comments on their own (issue #71) ----------
 *
 * The review role used to post four words by uploading the whole script and
 * having the server prove, by comparing it against the stored one, that only
 * a comment had moved. `POST /api/docs/:id/comments` is that same act with
 * nothing else in the envelope, so most of what is below is about the things
 * a comparison used to be needed for: that only a comment lands, that two of
 * them at once both land, and that a document the comparison used to choke
 * on (#62) is now simply a document.
 */

const sCmt = await startServer({
  JOIN_PIN: PIN,
  REVIEW_PIN,
  REVIEW_KEY,
  HOST: "127.0.0.1"
});

try {
  const joinAs = async (payload) => await json(await fetch(sCmt.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));

  const editToken = (await joinAs({ pin: PIN })).token;
  const reviewToken = (await joinAs({ pin: REVIEW_PIN })).token;
  const hdr = (token) => ({ "Content-Type": "application/json", "x-splitpage-token": token });

  const make = async (title) => await json(await fetch(sCmt.base + "api/docs", {
    method: "POST", headers: hdr(editToken),
    body: JSON.stringify({ state: Object.assign(fixtureState(), { title }) })
  }));
  const readDocAs = async (docId, token) =>
    await json(await fetch(sCmt.base + "api/docs/" + docId, { headers: { "x-splitpage-token": token } }));

  const doc = await make("Comments endpoint");
  const otherDoc = await make("Somebody else's script");
  const cmtUrl = (docId) => sCmt.base + "api/docs/" + docId + "/comments";

  const post = (docId, token, payload) => fetch(cmtUrl(docId), {
    method: "POST", headers: hdr(token), body: JSON.stringify(payload)
  });
  const patch = (docId, token, cid, payload) => fetch(cmtUrl(docId) + "/" + cid, {
    method: "PATCH", headers: hdr(token), body: JSON.stringify(payload)
  });

  const note = (id, extra) => Object.assign({
    id, rowId: "r1", field: "audioText", anchorId: id,
    quotedText: "there", author: "Reviewer", body: "a note", kind: "anchor"
  }, extra || {});

  /* ---- the happy path: a comment, and nothing else in the envelope ---- */
  let afterFirst = 0;
  {
    const before = await readDocAs(doc.id, editToken);
    const res = await post(doc.id, reviewToken, { comment: note("n1"), by: "Reviewer" });
    const body = await json(res);
    eq("a reviewer may post a comment on its own", res.status, 200);
    eq("...and is told the new rev", body && body.rev, (before.rev || 0) + 1);
    eq("...that something was written", body && body.changed, true);
    check("...and handed the stored comment back", !!(body && body.comment && body.comment.id === "n1"));
    eq("...unresolved, whatever was sent", body && body.comment.resolved, false);
    check("...stamped by the server's own clock, not the client's",
      !!(body && body.comment.createdAt && body.comment.createdAt !== "2026-02-01T00:00:00.000Z"));
    afterFirst = body && body.rev;

    const now = await readDocAs(doc.id, editToken);
    check("...and it is in the document", (now.state.comments || []).some((c) => c.id === "n1"));
    eq("...beside the one that was already there", (now.state.comments || []).length, 2);
    eq("...with the script untouched", now.state.rows[0].audioText, "Hello there");
    eq("...and the reviewer's name on the document", now.state.lastEditedBy, "Reviewer");
  }

  /* ---- the rev and the head line agree afterwards (#74) ---- */
  {
    const file = join(sCmt.dataDir, doc.id + ".json");
    const head = headOfFile(file);
    eq("a comment write moves the head line's rev with it", head.rev, afterFirst);
    eq("...keeps the title on it", head.title, "Comments endpoint");
    eq("...and the scene count", head.rows, 1);
    const read = await readDocAs(doc.id, editToken);
    eq("...and the document reads at that same rev", read.rev, afterFirst);
    check("a comment write leaves no temp file behind",
      !readdirSync(sCmt.dataDir).some((n) => n.endsWith(".tmp")),
      readdirSync(sCmt.dataDir).join(", "));
  }

  /* ---- an editor may use it too ---- */
  {
    const res = await post(doc.id, editToken, { comment: note("n2", { author: "Host" }) });
    eq("an editor may post through it as well", res.status, 200);
  }

  /* ---- the anchor: one field of one scene, never the script ---- */
  {
    const res = await post(doc.id, reviewToken, {
      comment: note("n3"),
      anchor: {
        rowId: "r1", field: "audioText",
        html: 'Hello <span class="cmt-anchor" data-cmt="n3">there</span>'
      },
      by: "Reviewer"
    });
    const body = await json(res);
    eq("a comment may carry the anchor it wrapped", res.status, 200);
    eq("...and is told it was placed", body && body.anchored, true);
    const now = await readDocAs(doc.id, editToken);
    eq("...which is in the scene", now.state.rows[0].audioText,
      'Hello <span class="cmt-anchor" data-cmt="n3">there</span>');
    eq("...and the scene is stamped with who anchored it", now.state.rows[0].updatedBy, "Reviewer");
  }
  {
    const res = await post(doc.id, reviewToken, {
      comment: note("n4"),
      anchor: { rowId: "r1", field: "audioText", html: 'Hello there, and a word the reviewer added' }
    });
    const body = await json(res);
    eq("an anchor that would change the words is not placed", body && body.anchored, false);
    eq("...but the comment still lands, rather than being lost", res.status, 200);
    const now = await readDocAs(doc.id, editToken);
    check("...it is stored", (now.state.comments || []).some((c) => c.id === "n4"));
    eq("...and the scene is exactly as it was",
      now.state.rows[0].audioText, 'Hello <span class="cmt-anchor" data-cmt="n3">there</span>');
  }
  {
    const res = await post(doc.id, reviewToken, {
      comment: note("n5"), anchor: { rowId: "r1", field: "status", html: "done" }
    });
    const body = await json(res);
    eq("an anchor on a field that holds no text is refused outright", res.status, 400);
    eq("...saying bad-anchor", body && body.error, "bad-anchor");
    const now = await readDocAs(doc.id, editToken);
    check("...and nothing was written", !(now.state.comments || []).some((c) => c.id === "n5"));
  }

  /* ---- replies ---- */
  {
    const before = await readDocAs(doc.id, editToken);
    const wasAt = before.state.comments.find((c) => c.id === "n1").updatedAt;
    const res = await post(doc.id, reviewToken, {
      replyTo: "n1", reply: { id: "rp1", author: "Reviewer", body: "and another thing" }
    });
    const body = await json(res);
    eq("a reply goes through the same route", res.status, 200);
    eq("...and comes back on its thread", body && body.comment && body.comment.replies.length, 1);
    check("...whose own timestamp moved", body.comment.updatedAt !== wasAt);
    const now = await readDocAs(doc.id, editToken);
    eq("...and it is stored", now.state.comments.find((c) => c.id === "n1").replies[0].body,
      "and another thing");
  }
  {
    const res = await post(doc.id, reviewToken, {
      replyTo: "nothing-here", reply: { id: "rp2", body: "hello?" }
    });
    const body = await json(res);
    eq("a reply to a comment that is not there is 404", res.status, 404);
    eq("...saying no-such-comment", body && body.error, "no-such-comment");
  }

  /* ---- resolve: an editor's, never a reviewer's ----
     The owner's decision: reviewers never resolve or unresolve. Authorship
     cannot be established here (an author is a typed name, and everyone on a
     review link shares one token), so any resolve by a reviewer would be a
     resolve of somebody else's comment. */
  {
    const before = await readDocAs(doc.id, editToken);
    const res = await patch(doc.id, reviewToken, "n1", { resolved: true, by: "Reviewer" });
    eq("a reviewer may not resolve a comment", res.status, 403);
    eq("...saying reviewers-cannot-resolve", (await json(res) || {}).error, "reviewers-cannot-resolve");
    const unres = await patch(doc.id, reviewToken, "n1", { resolved: false });
    eq("...nor unresolve one", unres.status, 403);
    const nonsense = await patch(doc.id, reviewToken, "n1", { resolved: "yes" });
    eq("...and is refused on the role, not on what was sent", nonsense.status, 403);
    const missing = await patch(doc.id, reviewToken, "nope", { resolved: true });
    eq("...whether or not the comment is there", missing.status, 403);
    const after = await readDocAs(doc.id, editToken);
    eq("...and none of it moved the rev", after.rev, before.rev);
    const n1 = after.state.comments.find((c) => c.id === "n1");
    eq("...or resolved the comment", n1 && n1.resolved, false);
    eq("...or named a resolver", n1 && (n1.resolvedBy || null), null);

    const scoped = await json(await fetch(sCmt.base + "api/share?doc=" + doc.id, {
      headers: { "x-splitpage-token": editToken }
    }));
    const scopedToken = (await joinAs({ key: scoped.reviewKey })).token;
    const viaLink = await patch(doc.id, scopedToken, "n1", { resolved: true });
    eq("a per-document review link's token is refused the same way", viaLink.status, 403);
    eq("...saying reviewers-cannot-resolve", (await json(viaLink) || {}).error, "reviewers-cannot-resolve");

    /* Refused before a byte of the body is read (#74): 20 MB announced,
       twenty bytes sent. An answer at all is the proof. */
    const early = await refuseBeforeBody(sCmt.base, "/api/docs/" + doc.id + "/comments/n1", "PATCH",
      { "x-splitpage-token": reviewToken });
    eq("a reviewer's resolve is refused before its body is read", early.status, 403);
    eq("...and the rev still stands", (await readDocAs(doc.id, editToken)).rev, before.rev);
  }
  {
    const res = await patch(doc.id, editToken, "n1", { resolved: true, by: "Host" });
    const body = await json(res);
    eq("an editor resolves with a PATCH on the one comment", res.status, 200);
    eq("...which says so", body && body.comment && body.comment.resolved, true);
    eq("...and records who", body && body.comment.resolvedBy, "Host");
    const stored = await readDocAs(doc.id, editToken);
    eq("...and it is stored resolved", stored.state.comments.find((c) => c.id === "n1").resolved, true);

    const again = await json(await patch(doc.id, editToken, "n1", { resolved: true }));
    eq("resolving an already-resolved comment writes nothing", again && again.changed, false);
    eq("...and the rev stands still", again && again.rev, body.rev);

    const blocked = await patch(doc.id, reviewToken, "n1", { resolved: false });
    eq("a reviewer may not unresolve an editor's resolve either", blocked.status, 403);

    const undo = await json(await patch(doc.id, editToken, "n1", { resolved: false }));
    eq("an editor unresolves", undo && undo.comment.resolved, false);
    eq("...which clears the resolver", undo && undo.comment.resolvedBy, null);
    eq("...and the time with it", undo && undo.comment.resolvedAt, null);
    eq("...and is a new rev", undo && undo.rev, body.rev + 1);

    const missing = await patch(doc.id, editToken, "nope", { resolved: true });
    eq("resolving a comment that is not there is 404", missing.status, 404);
    const nonsense = await patch(doc.id, editToken, "n1", { resolved: "yes" });
    eq("...and a resolve that is not a boolean is 400", nonsense.status, 400);
  }

  /* ---- posting the same comment twice ----
     A client that lost the answer to a dropped connection and tried again. */
  {
    const first = await json(await post(doc.id, reviewToken, { comment: note("dup") }));
    const second = await json(await post(doc.id, reviewToken, { comment: note("dup", { body: "different words" }) }));
    eq("the same comment posted twice does not land twice", second && second.changed, false);
    eq("...the rev stands still", second && second.rev, first.rev);
    eq("...and the stored one is the first one", second && second.comment.body, "a note");
    const now = await readDocAs(doc.id, editToken);
    eq("...with one copy in the document",
      (now.state.comments || []).filter((c) => c.id === "dup").length, 1);
  }

  /* ---- the shape a comment has to have ---- */
  {
    const cases = [
      ["a comment with no id", { comment: note("") }],
      ["a comment with an id that is not one", { comment: note("../../etc") }],
      ["a comment with no body", { comment: note("n6", { body: "" }) }],
      ["a comment on no scene at all", { comment: { id: "n7", field: "audioText", body: "x" } }],
      ["a body that is not a comment", { comment: "hello" }],
      ["an empty request", {}]
    ];
    for (const [name, payload] of cases) {
      const res = await post(doc.id, reviewToken, payload);
      eq(name + " is 400", res.status, 400);
    }
    const stray = await json(await post(doc.id, reviewToken, {
      comment: note("n8", { resolved: true, resolvedBy: "Reviewer", replies: [{ id: "x", body: "y" }] })
    }));
    eq("a comment cannot arrive pre-resolved", stray && stray.comment.resolved, false);
    eq("...nor with replies already on it", stray && stray.comment.replies.length, 0);
    check("...and carries no key this server has not heard of",
      Object.keys(stray.comment).sort().join(",") ===
      "anchorId,assignee,author,body,createdAt,field,id,kind,quotedText,replies,resolved,resolvedAt,resolvedBy,rowId,updatedAt");
  }

  /* ---- what is not a route here ---- */
  {
    const read = await fetch(cmtUrl(doc.id), { headers: { "x-splitpage-token": reviewToken } });
    eq("there is no GET of the comments — reading is the document's own route", read.status, 405);
    const deep = await fetch(cmtUrl(doc.id) + "/n1/replies", {
      method: "POST", headers: hdr(reviewToken), body: "{}"
    });
    eq("...and no deeper path than the one comment", deep.status, 404);
    const badCid = await patch(doc.id, editToken, "not a comment id", { resolved: true });
    eq("...and a comment id that is not one is 400", badCid.status, 400);
  }

  /* ---- the review link's scope (#63) holds here too ---- */
  {
    const scoped = await json(await fetch(sCmt.base + "api/share?doc=" + doc.id, {
      headers: { "x-splitpage-token": editToken }
    }));
    const scopedToken = (await joinAs({ key: scoped.reviewKey })).token;

    const mine = await post(doc.id, scopedToken, { comment: note("s1") });
    eq("a per-document review token comments on the document it names", mine.status, 200);

    const theirs = await post(otherDoc.id, scopedToken, { comment: note("s2") });
    const body = await json(theirs);
    eq("...and on no other", theirs.status, 403);
    eq("...saying wrong-document", body && body.error, "wrong-document");
    const over = await readDocAs(otherDoc.id, scopedToken);
    check("...nor reads that one's state", !(over && over.state));
    const listed = await json(await fetch(sCmt.base + "api/docs", { headers: { "x-splitpage-token": scopedToken } }));
    eq("...nor lists the library", (listed && listed.docs || []).length, 1);

    /* And the refusal happens before a byte of the body is read (#74): this
       request announces 20 MB and sends twenty bytes of it. An answer at all
       is the proof. */
    const early = await refuseBeforeBody(sCmt.base, "/api/docs/" + otherDoc.id + "/comments", "POST",
      { "x-splitpage-token": scopedToken });
    eq("a comment for the wrong document is refused before its body is read", early.status, 403);

    const noToken = await fetch(cmtUrl(doc.id), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ comment: note("s3") })
    });
    eq("and with no token at all it is the gate that answers", noToken.status, 401);
  }

  /* ---- the cap: a comment, not a script ----
     MAX_BODY is 25 MB because a whole script with its images has to fit
     through PUT. Nothing a reviewer sends here is anywhere near that. */
  {
    const huge = await post(doc.id, reviewToken, {
      comment: note("big", { body: "x".repeat(600 * 1024) })
    });
    eq("a comment over this route's cap is 413", huge.status, 413);
    eq("...saying too-large", (await json(huge) || {}).error, "too-large");

    const large = await post(doc.id, reviewToken, {
      comment: note("big2", { body: "x".repeat(300 * 1024) })
    });
    eq("a single comment body over its own bound is 400", large.status, 400);

    const now = await readDocAs(doc.id, editToken);
    check("...and neither was written",
      !(now.state.comments || []).some((c) => c.id === "big" || c.id === "big2"));
  }

  /* ---- two reviewers at once ----
     The whole reason the append happens inside the document's lock rather
     than as a read-modify-write: with the old PUT one of these two would
     have lost, and been handed a 409 to merge and try again. */
  {
    const before = await readDocAs(doc.id, editToken);
    const scoped = await json(await fetch(sCmt.base + "api/share?doc=" + doc.id, {
      headers: { "x-splitpage-token": editToken }
    }));
    const scopedToken = (await joinAs({ key: scoped.reviewKey })).token;

    const [a, b] = await Promise.all([
      post(doc.id, reviewToken, { comment: note("race-a", { author: "Ada" }), by: "Ada" }),
      post(doc.id, scopedToken, { comment: note("race-b", { author: "Bo" }), by: "Bo" })
    ]);
    eq("two reviewers commenting at once both succeed", a.status + "/" + b.status, "200/200");
    const revs = [(await json(a)).rev, (await json(b)).rev].sort((x, y) => x - y);
    eq("...at consecutive revs, one behind the other", revs.join(","),
      [(before.rev || 0) + 1, (before.rev || 0) + 2].join(","));

    const now = await readDocAs(doc.id, editToken);
    check("...and neither comment was lost", ["race-a", "race-b"]
      .every((cid) => (now.state.comments || []).some((c) => c.id === cid)));
    eq("...the document's rev matching the later of the two", now.rev, revs[1]);
    eq("...and the head line with it", headOfFile(join(sCmt.dataDir, doc.id + ".json")).rev, revs[1]);
  }
  {
    /* Ten at once, to be sure it is the lock doing it and not luck. */
    const before = await readDocAs(doc.id, editToken);
    const many = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      post(doc.id, reviewToken, { comment: note("many-" + i, { author: "R" + i }) })));
    eq("ten comments posted at once all succeed",
      many.filter((r) => r.status === 200).length, 10);
    const now = await readDocAs(doc.id, editToken);
    eq("...and all ten are there",
      (now.state.comments || []).filter((c) => /^many-/.test(c.id)).length, 10);
    eq("...the rev counting every one of them", now.rev, (before.rev || 0) + 10);
  }

  /* ---- a document saved before any of this existed (#62) ----
     No head line, no `comments` array, and none of the fields the client
     fills in on load — which is exactly the document whose reviewers used
     to be told "review-only" because their copy carried `brollShots: []`
     and the stored one carried no such key. There is nothing to compare
     here any more, so there is nothing to disagree about. */
  {
    const legacyPath = join(sCmt.dataDir, "legacy-comment.json");
    writeFileSync(legacyPath, JSON.stringify({
      id: "legacy-comment",
      rev: 4,
      state: {
        title: "Saved the old way",
        rows: [{ id: "r1", visualText: "", audioText: "Hello there" }]
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
      updatedBy: "Host"
    }));

    const res = await post("legacy-comment", reviewToken, {
      comment: note("old1"),
      anchor: {
        rowId: "r1", field: "audioText",
        html: 'Hello <span class="cmt-anchor" data-cmt="old1">there</span>'
      },
      by: "Reviewer"
    });
    const body = await json(res);
    eq("a comment on a document saved before brollShots existed is 200, not 403", res.status, 200);
    eq("...counting on from the rev it had", body && body.rev, 5);
    eq("...and its anchor lands like any other", body && body.anchored, true);

    const now = await readDocAs("legacy-comment", editToken);
    eq("...the comments array is created for it", (now.state.comments || []).length, 1);
    check("...nothing else in it was touched",
      now.state.title === "Saved the old way" && now.state.rows.length === 1);
    eq("...and it has a head line from now on, at the rev it is really at",
      headOfFile(legacyPath).rev, 5);
  }
  {
    const gone = await post("not-a-document", reviewToken, { comment: note("x1") });
    eq("a comment on a document that is not there is 404", gone.status, 404);
    const bad = await post("Not-An-Id", reviewToken, { comment: note("x2") });
    eq("...and on an id that is not one, 400", bad.status, 400);
  }

  /* ---- the old path is closed (#71) ----
     The review client posts through the routes above. A whole-document PUT
     from a review token is refused outright — even one that carries nothing
     but a comment, which the deleted comparison used to let through — and
     an editor's PUT of that very same state is written exactly as before. */
  {
    const now = await readDocAs(doc.id, reviewToken);
    const next = JSON.parse(JSON.stringify(now.state));
    next.comments.push(Object.assign(note("put1"), {
      createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z",
      resolved: false, replies: []
    }));
    const res = await fetch(sCmt.base + "api/docs/" + doc.id, {
      method: "PUT", headers: hdr(reviewToken),
      body: JSON.stringify({ baseRev: now.rev, state: next, by: "Reviewer" })
    });
    eq("a whole-document review PUT is refused, even carrying nothing but a comment", res.status, 403);
    eq("...saying review-only", (await json(res) || {}).error, "review-only");
    const after = await readDocAs(doc.id, editToken);
    eq("...the rev did not move", after.rev, now.rev);
    check("...and the comment was not written", !(after.state.comments || []).some((c) => c.id === "put1"));

    const worse = JSON.parse(JSON.stringify(next));
    worse.rows[0].audioText = "a reviewer rewriting the script";
    const refused = await fetch(sCmt.base + "api/docs/" + doc.id, {
      method: "PUT", headers: hdr(reviewToken),
      body: JSON.stringify({ baseRev: after.rev, state: worse })
    });
    eq("...and so, of course, is one that rewrites the script", refused.status, 403);
    eq("...saying review-only", (await json(refused) || {}).error, "review-only");

    const asEditor = await fetch(sCmt.base + "api/docs/" + doc.id, {
      method: "PUT", headers: hdr(editToken),
      body: JSON.stringify({ baseRev: after.rev, state: next, by: "Host" })
    });
    eq("an editor's PUT of that same state is written as before", asEditor.status, 200);
    eq("...moving the rev by one", (await json(asEditor) || {}).rev, after.rev + 1);
    check("...with the comment in it",
      (await readDocAs(doc.id, editToken)).state.comments.some((c) => c.id === "put1"));
  }
} finally {
  sCmt.stop();
}

/* A published library takes no comments either — it is not a write with an
   exemption, it is a write. */
const sCmtRO = await startServer({ HOST: "127.0.0.1", READ_ONLY: "1" });
try {
  writeFileSync(join(sCmtRO.dataDir, "frozen-doc.json"), JSON.stringify({
    id: "frozen-doc", rev: 1,
    state: { title: "Frozen", rows: [{ id: "r1", audioText: "Hello" }], comments: [] },
    updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "Host"
  }));
  const res = await fetch(sCmtRO.base + "api/docs/frozen-doc/comments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comment: { id: "f1", rowId: "r1", field: "audioText", body: "no" } })
  });
  const body = await json(res);
  eq("a read-only library refuses a comment", res.status, 403);
  eq("...saying read-only", body && body.error, "read-only");
} finally {
  sCmtRO.stop();
}

/* ---------- images as content-addressed blobs (#82) ----------
 *
 * PUT/GET/missing under /api/blobs, the 422 a save or a comment gets for an
 * image the server does not hold, a review link's view of the blob store
 * (only what its document names, plus what it uploaded itself), a
 * reviewer's upload budget, and the D7 gate that stops a client predating
 * blob refs from saving over a document that holds some.
 */
const BLOB_BUDGET = 10000;   /* two small uploads (each charged at least 4096) and no third */
const sBlob = await startServer({
  JOIN_PIN: PIN,
  REVIEW_PIN,
  REVIEW_KEY,
  ALLOW_ORIGINS: ORIGIN,
  HOST: "127.0.0.1",
  MAX_BLOB_BYTES: "65536",
  REVIEW_BLOB_BUDGET_BYTES: String(BLOB_BUDGET)
});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngOf(size) {
  return Buffer.concat([PNG_SIG, randomBytes(Math.max(8, size - PNG_SIG.length))]);
}
function jpegOf(size) {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size - 4)]);
}
const shaOf = (buf) => createHash("sha256").update(buf).digest("hex");

try {
  const joinAs = async (payload) => await json(await fetch(sBlob.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
  const editToken = (await joinAs({ pin: PIN })).token;
  const reviewToken = (await joinAs({ pin: REVIEW_PIN })).token;
  const NEW = { "x-splitpage-client": "2" };
  const hdr = (token, extra) => Object.assign({ "Content-Type": "application/json", "x-splitpage-token": token }, extra || {});

  const putBlob = (token, buf, sha) => fetch(sBlob.base + "api/blobs/" + (sha || shaOf(buf)), {
    method: "PUT",
    headers: Object.assign({ "Content-Type": "application/octet-stream", "x-splitpage-token": token }, NEW),
    body: buf
  });
  const getBlob = (token, sha, extra) => fetch(sBlob.base + "api/blobs/" + sha, {
    headers: Object.assign({ "x-splitpage-token": token }, NEW, extra || {})
  });
  const missingAs = async (token, shas) => fetch(sBlob.base + "api/blobs/missing", {
    method: "POST", headers: hdr(token, NEW), body: JSON.stringify({ shas })
  });
  const withImage = (title, sha, extra) => Object.assign(fixtureState(), { title }, extra || {}, {
    rows: [Object.assign(fixtureState().rows[0], { imageRef: sha ? { sha256: sha, width: 4, height: 3, mime: "image/png" } : null })]
  });
  const createDoc = (state, extra) => fetch(sBlob.base + "api/docs", {
    method: "POST", headers: hdr(editToken, NEW), body: JSON.stringify(Object.assign({ state }, extra || {}))
  });
  const putDoc = (docId, baseRev, state, headers, extra) => fetch(sBlob.base + "api/docs/" + docId, {
    method: "PUT", headers: hdr(editToken, headers), body: JSON.stringify(Object.assign({ baseRev, state }, extra || {}))
  });

  {
    const body = await json(await fetch(sBlob.base + "api/health"));
    eq("health says this server keeps blobs", body && body.blobs, 1);
    const pre = await fetch(sBlob.base + "api/blobs/missing", {
      method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" }
    });
    check("CORS lets the client-version header through",
      (pre.headers.get("access-control-allow-headers") || "").includes("x-splitpage-client"));
  }

  /* ---- round trip ---- */
  const one = pngOf(600);
  const oneSha = shaOf(one);
  {
    const res = await putBlob(editToken, one);
    eq("an editor's PUT of a new PNG is 201", res.status, 201);
    eq("...stored:true", (await json(res) || {}).stored, true);
    check("...at blobs/<aa>/<sha>", existsSync(join(sBlob.dataDir, "blobs", oneSha.slice(0, 2), oneSha)));
    const again = await putBlob(editToken, one);
    eq("PUT of the same bytes again is 200", again.status, 200);
    eq("...stored:false", (await json(again) || {}).stored, false);
  }
  {
    const res = await getBlob(editToken, oneSha);
    eq("GET of it is 200", res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    check("...with the same bytes", bytes.equals(one));
    eq("...Content-Type sniffed", res.headers.get("content-type"), "image/png");
    eq("...immutable cache", res.headers.get("cache-control"), "private, max-age=31536000, immutable");
    eq("...ETag is the sha", res.headers.get("etag"), "\"" + oneSha + "\"");
    eq("...nosniff", res.headers.get("x-content-type-options"), "nosniff");
    eq("...a CSP that runs nothing", res.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    const cached = await getBlob(editToken, oneSha, { "If-None-Match": "\"" + oneSha + "\"" });
    eq("If-None-Match with the sha is 304", cached.status, 304);
  }
  {
    eq("GET without a token is 401", (await fetch(sBlob.base + "api/blobs/" + oneSha)).status, 401);
    eq("GET of an unknown sha is 404", (await getBlob(editToken, "0".repeat(64))).status, 404);
    eq("GET of something that is not a sha is 400", (await getBlob(editToken, "ABC")).status, 400);
    eq("...nor is upper-case hex", (await getBlob(editToken, oneSha.toUpperCase())).status, 400);
  }
  {
    const jpg = jpegOf(500);
    const res = await putBlob(editToken, jpg);
    eq("a JPEG is stored", res.status, 201);
    eq("...and served as image/jpeg", (await getBlob(editToken, shaOf(jpg))).headers.get("content-type"), "image/jpeg");
  }

  /* ---- refusals ---- */
  {
    const res = await putBlob(editToken, pngOf(300), "a".repeat(64));
    eq("bytes that do not hash to the name are 400", res.status, 400);
    eq("...hash-mismatch", (await json(res) || {}).error, "hash-mismatch");
    check("...and nothing is stored under that name", !existsSync(join(sBlob.dataDir, "blobs", "aa", "a".repeat(64))));
  }
  {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await putBlob(editToken, svg);
    eq("an SVG is 415", res.status, 415);
    eq("...unsupported-type", (await json(res) || {}).error, "unsupported-type");
    const text = Buffer.from("just some text, long enough to sniff");
    eq("so is plain text", (await putBlob(editToken, text)).status, 415);
  }
  {
    const res = await putBlob(editToken, pngOf(70000));
    eq("a blob over MAX_BLOB_BYTES is 413", res.status, 413);
    const early = await refuseBeforeBody(sBlob.base, "api/blobs/" + "b".repeat(64), "PUT",
      { "x-splitpage-token": editToken });
    eq("...refused on its declared length, before the body", early.status, 413);
  }

  /* ---- missing ---- */
  {
    const res = await missingAs(editToken, [oneSha, "c".repeat(64), oneSha]);
    eq("missing answers 200", res.status, 200);
    const body = await json(res);
    eq("...naming only what is not here", JSON.stringify(body && body.missing), JSON.stringify(["c".repeat(64)]));
    eq("more than 2000 shas is 400", (await missingAs(editToken, new Array(2001).fill(oneSha))).status, 400);
    eq("a non-sha in the list is 400", (await missingAs(editToken, ["nope"])).status, 400);
  }

  /* ---- the list route ignores blobs/ ---- */
  {
    const res = await fetch(sBlob.base + "api/docs", { headers: hdr(editToken) });
    const body = await json(res);
    check("blobs/ exists in DATA_DIR", readdirSync(sBlob.dataDir).includes("blobs"));
    eq("...and the picker lists no documents for it", body && body.docs && body.docs.length, 0);
  }

  /* ---- saves naming images ---- */
  const unknown = "d".repeat(64);
  let refDoc = null;
  {
    const bad = await createDoc(withImage("Needs an upload", unknown));
    eq("creating a document naming an unknown blob is 422", bad.status, 422);
    const body = await json(bad);
    eq("...missing-blobs", body && body.error, "missing-blobs");
    eq("...naming it", JSON.stringify(body && body.missing), JSON.stringify([unknown]));
    const ok = await createDoc(withImage("Has an image", oneSha));
    eq("creating one naming a stored blob is 201", ok.status, 201);
    refDoc = await json(ok);
    const accepted = await createDoc(withImage("Knows it is gone", unknown), { acceptMissing: [unknown] });
    eq("...and one naming a lost blob listed in acceptMissing is 201", accepted.status, 201);
  }
  {
    const doc = await json(await fetch(sBlob.base + "api/docs/" + refDoc.id, { headers: hdr(editToken) }));
    const next = JSON.parse(JSON.stringify(doc.state));
    next.rows.push(Object.assign({}, next.rows[0], { id: "r2", imageRef: { sha256: unknown, width: 1, height: 1, mime: "image/png" } }));
    const bad = await putDoc(refDoc.id, doc.rev, next, NEW);
    eq("a PUT adding an unknown blob ref is 422", bad.status, 422);
    eq("...naming just that one", JSON.stringify((await json(bad) || {}).missing), JSON.stringify([unknown]));
    const after = await json(await fetch(sBlob.base + "api/docs/" + refDoc.id, { headers: hdr(editToken) }));
    eq("...and nothing was written", after.rev, doc.rev);

    const html = JSON.parse(JSON.stringify(doc.state));
    html.rows[0].visualText = 'Shot <img class="comment-img" data-blob="' + "e".repeat(64) + '" data-w="1" data-h="1">';
    const badHtml = await putDoc(refDoc.id, doc.rev, html, NEW);
    eq("a data-blob image in a row's HTML counts too", badHtml.status, 422);
    const text = JSON.parse(JSON.stringify(doc.state));
    text.rows[0].audioText = 'She says data-blob="' + "e".repeat(64) + '" out loud';
    eq("...but words that only look like one do not", (await putDoc(refDoc.id, doc.rev, text, NEW)).status, 200);

    const cur = await json(await fetch(sBlob.base + "api/docs/" + refDoc.id, { headers: hdr(editToken) }));
    const ok = await putDoc(refDoc.id, cur.rev, next, NEW, { acceptMissing: [unknown] });
    eq("...the same PUT with acceptMissing is 200", ok.status, 200);
    const okBody = await json(ok);
    const again = JSON.parse(JSON.stringify(next));
    again.title = "Renamed";
    eq("a later PUT still naming that already-dangling ref is 200",
      (await putDoc(refDoc.id, okBody.rev, again, NEW)).status, 200);
  }

  /* ---- legacy base64 and D7 ---- */
  {
    const legacy = Object.assign(fixtureState(), { title: "Old style" });
    legacy.rows[0].visualImage = "data:image/png;base64," + pngOf(200).toString("base64");
    const made = await json(await createDoc(legacy));
    const res = await putDoc(made.id, made.rev, legacy, {});
    eq("a legacy base64 PUT from a client with no version header is still accepted", res.status, 200);
  }
  {
    const cur = await json(await fetch(sBlob.base + "api/docs/" + refDoc.id, { headers: hdr(editToken) }));
    const res = await putDoc(refDoc.id, cur.rev, cur.state, {});
    eq("D7: a PUT with no client header on a document holding refs is 426", res.status, 426);
    eq("...client-too-old", (await json(res) || {}).error, "client-too-old");
    eq("...as it is from client 1", (await putDoc(refDoc.id, cur.rev, cur.state, { "x-splitpage-client": "1" })).status, 426);
    const early = await refuseBeforeBody(sBlob.base, "api/docs/" + refDoc.id, "PUT", { "x-splitpage-token": editToken });
    eq("...refused before the body", early.status, 426);
    eq("...while client 2 saves it", (await putDoc(refDoc.id, cur.rev, cur.state, NEW)).status, 200);
  }

  /* ---- comments naming images ---- */
  {
    const url = sBlob.base + "api/docs/" + refDoc.id + "/comments";
    const post = (token, payload, headers) => fetch(url, { method: "POST", headers: hdr(token, headers), body: JSON.stringify(payload) });
    const img = (sha) => 'look <img class="comment-img" data-blob="' + sha + '" data-w="1" data-h="1">';
    const note = (id, body) => ({ id, rowId: "r1", field: "audioText", body, author: "Rev" });
    const bad = await post(reviewToken, { comment: note("bi1", img("f".repeat(64))) }, NEW);
    eq("a comment naming an image the server lacks is 422", bad.status, 422);
    eq("...missing-blobs, naming it", JSON.stringify((await json(bad) || {}).missing), JSON.stringify(["f".repeat(64)]));
    const ok = await post(reviewToken, { comment: note("bi2", img(oneSha)) }, NEW);
    eq("...one naming a stored image lands", ok.status, 200);
    const reply = await post(editToken, { replyTo: "bi2", reply: { id: "br1", body: img("f".repeat(64)) } }, NEW);
    eq("a reply naming a missing image is 422 too", reply.status, 422);
    const oldClient = await post(reviewToken, { comment: note("bi3", "plain words") }, {});
    eq("an old client's text comment on a document with refs is still taken", oldClient.status, 200);
  }

  /* ---- reviewers: a review link sees only its own document's images ---- */
  const hidden = pngOf(400);
  const hiddenSha = shaOf(hidden);
  eq("(a second image, named by no document)", (await putBlob(editToken, hidden)).status, 201);
  {
    const share = await json(await fetch(sBlob.base + "api/share?doc=" + refDoc.id, { headers: hdr(editToken) }));
    const link = await joinAs({ key: share.reviewKey });
    const linkToken = link.token;
    eq("(the review link is scoped to the document)", link.docId, refDoc.id);

    eq("a review link may GET an image its document names", (await getBlob(linkToken, oneSha)).status, 200);
    const other = await getBlob(linkToken, hiddenSha);
    eq("...but an image it does not name is 404, though it exists", other.status, 404);
    eq("...while the library-wide review token may GET it", (await getBlob(reviewToken, hiddenSha)).status, 200);

    const miss = await json(await missingAs(linkToken, [oneSha, hiddenSha]));
    eq("missing, asked by the link, calls the image it cannot see missing",
      JSON.stringify(miss && miss.missing), JSON.stringify([hiddenSha]));

    const url = sBlob.base + "api/docs/" + refDoc.id + "/comments";
    const img = 'shot <img class="comment-img" data-blob="' + hiddenSha + '" data-w="1" data-h="1">';
    const probe = await fetch(url, { method: "POST", headers: hdr(linkToken, NEW),
      body: JSON.stringify({ comment: { id: "lk1", rowId: "r1", field: "audioText", body: img, author: "Link" } }) });
    eq("a link's comment naming an image it cannot see is 422, though it exists", probe.status, 422);

    const up = await putBlob(linkToken, hidden);
    eq("the link uploading those bytes is told 201", up.status, 201);
    eq("...stored:true, the same as for a new image", (await json(up) || {}).stored, true);
    eq("...after which it may GET what it uploaded", (await getBlob(linkToken, hiddenSha)).status, 200);
    const posted = await fetch(url, { method: "POST", headers: hdr(linkToken, NEW),
      body: JSON.stringify({ comment: { id: "lk1", rowId: "r1", field: "audioText", body: img, author: "Link" } }) });
    eq("...and post the comment carrying it", posted.status, 200);
  }

  /* ---- a reviewer's upload budget ---- */
  {
    /* Twice, and first: a re-send of bytes already here is charged nothing,
       which is why the two uploads below still both fit. */
    eq("a reviewer re-sending bytes already here is 200", (await putBlob(reviewToken, one)).status, 200);
    eq("...and again, charged nothing", (await putBlob(reviewToken, one)).status, 200);
    const a = await putBlob(reviewToken, pngOf(3000));
    eq("a reviewer's upload within the budget is 201", a.status, 201);
    const b = await putBlob(reviewToken, pngOf(3000));
    eq("...and a second", b.status, 201);
    const c = await putBlob(reviewToken, pngOf(3000));
    eq("...a third, over the budget, is 429", c.status, 429);
    eq("...review-budget", (await json(c) || {}).error, "review-budget");
    const early = await refuseBeforeBody(sBlob.base, "api/blobs/" + "9".repeat(64), "PUT",
      { "x-splitpage-token": reviewToken, "Content-Length": "3000" });
    eq("...refused before its body is read", early.status, 429);
    eq("...while an editor is not held to it", (await putBlob(editToken, pngOf(3000))).status, 201);
  }
} finally {
  sBlob.stop();
}

/* A published library stores no images either. */
const sBlobRO = await startServer({ HOST: "127.0.0.1", READ_ONLY: "1" });
try {
  const out = await refuseBeforeBody(sBlobRO.base, "api/blobs/" + "a".repeat(64), "PUT", { "Content-Length": "100" });
  eq("a read-only library refuses a blob PUT before the body", out.status, 403);
  eq("...saying read-only", out.body && out.body.error, "read-only");
  const miss = await fetch(sBlobRO.base + "api/blobs/missing", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shas: ["a".repeat(64)] })
  });
  eq("...but still answers missing", miss.status, 200);
} finally {
  sBlobRO.stop();
}

console.log("");
if (failures.length) {
  console.log("FAILED " + failures.length + " of " + (passed + failures.length) + " checks:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL PASS - " + passed + "/" + passed + " server checks");
process.exit(0);
