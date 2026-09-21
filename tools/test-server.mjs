#!/usr/bin/env node
/* Behaviour tests for server/server.js — the join PIN, CORS, the
 * compare-and-set save, and the launcher's loopback-only routes.
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
import { mkdtempSync, rmSync } from "node:fs";
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
  HOST: "127.0.0.1",
  /* The update-staging route spawns update.mjs, which would otherwise ask
     GitHub for the latest release and — on a machine with network — actually
     download it into this checkout's .update/. Pointed at a closed port it
     fails immediately instead, which is all the route test needs: proof that
     the route ran the updater and reported its answer. */
  SPLITPAGE_UPDATE_API: "http://127.0.0.1:9/never"
});

let token = null;
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
    const res = await fetch(s2.base + "api/health", { headers: { "Origin": "null" } });
    eq("the literal origin `null` can be allowed, for a copy opened from disk",
      res.headers.get("access-control-allow-origin"), "null");
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

  /* the launcher's routes */
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
    check("...and says whether it could register it", body && typeof body.canRegister === "boolean");
    check("...and whether it already is", body && typeof body.installed === "boolean");
  }
  /* the staging route: the one launcher route that downloads a release */
  {
    const res = await fetch(s2.base + "api/launcher/update/stage", { method: "POST" });
    eq("launcher/update/stage without the launch header is 404", res.status, 404);
  }
  {
    const res = await fetch(s2.base + "api/launcher/update/stage", {
      method: "POST", headers: { "x-splitpage-launch": "wrong" }
    });
    eq("launcher/update/stage with the wrong launch token is 404", res.status, 404);
  }
  {
    /* POST only: staging is not something a GET (a link, a prefetch, an image
       src) should ever be able to start. */
    const res = await fetch(s2.base + "api/launcher/update/stage", {
      headers: { "x-splitpage-launch": LAUNCH }
    });
    eq("launcher/update/stage refuses GET", res.status, 404);
  }
  {
    const res = await fetch(s2.base + "api/launcher/update/stage", {
      method: "POST", headers: { "x-splitpage-launch": LAUNCH }
    });
    const body = await json(res);
    /* The updater ran and could not reach its update server. That is an
       answer, not a server fault, so it is a 200 carrying the reason —
       the page needs to read `error` to say which. */
    eq("launcher/update/stage with the launch token runs the updater", res.status, 200);
    check("...and reports the failure rather than staging", !!(body && body.ok === false));
    check("...naming what went wrong", !!(body && body.message));
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

/* the same server, reachable from the network: the launcher's routes are gone */
const s3 = await startServer({
  JOIN_PIN: PIN,
  LAUNCH_TOKEN: LAUNCH,
  HOST: "0.0.0.0"
});
try {
  const res = await fetch(s3.base + "api/launcher/info", { headers: { "x-splitpage-launch": LAUNCH } });
  eq("under --host, launcher/info is 404 even with the launch token", res.status, 404);
  const reg = await fetch(s3.base + "api/launcher/register", {
    method: "POST",
    headers: { "x-splitpage-launch": LAUNCH }
  });
  eq("...and so is register", reg.status, 404);
  const stage = await fetch(s3.base + "api/launcher/update/stage", {
    method: "POST",
    headers: { "x-splitpage-launch": LAUNCH }
  });
  eq("...and so is update/stage", stage.status, 404);
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
  {
    const res = await fetch(s4.base + "api/share", { headers: { "x-splitpage-token": editToken } });
    const body = await json(res);
    eq("an editor can read the review link's key", res.status, 200);
    eq("...which is this launch's, not the PIN", body && body.reviewKey, REVIEW_KEY);
    const asReviewer = await fetch(s4.base + "api/share", { headers: { "x-splitpage-token": reviewToken } });
    eq("a reviewer cannot — there is nothing for them to share", asReviewer.status, 403);
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

  /* Read, change one thing, write — the same round trip the app makes, and
     the only way to be sure a refusal below is the review rule refusing and
     not a stale rev conflicting. */
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

  {
    const res = await fetch(docUrl, {
      method: "DELETE", headers: { "x-splitpage-token": reviewToken }
    });
    eq("a reviewer cannot delete a document", res.status, 403);
  }

  /* the write a review session exists for: a comment, plus the anchor it
     wrapped around the words it is about */
  {
    const out = await reviewPut((st) => {
      st.comments.push(newComment("c2", "audioText"));
      st.rows[0].audioText = 'Hello <span class="cmt-anchor" data-cmt="c2">there</span>';
      st.rows[0].updatedAt = "2026-02-01T00:00:00.000Z";
      st.rows[0].updatedBy = "Reviewer";
      st.rev = 2;
      st.lastEditedBy = "Reviewer";
    });
    eq("a reviewer may add a comment and its anchor", out.status, 200);
  }
  {
    const res = await fetch(docUrl, { headers: { "x-splitpage-token": reviewToken } });
    const body = await json(res);
    check("...and it is stored", !!(body && (body.state.comments || []).some((c) => c.id === "c2")));
  }
  /* an anchor whose selection crossed a <strong> boundary: unwrapping it
     cannot glue the element back together, so the comparison has to see the
     two halves as the one run of text they render as */
  {
    const out = await reviewPut((st) => {
      st.comments.push(newComment("c3", "visualText", { quotedText: "shot of" }));
      st.rows[0].visualText =
        'Wide <strong></strong><span class="cmt-anchor" data-cmt="c3"><strong>shot</strong> of</span> the kitchen';
      st.rows[0].updatedAt = "2026-02-01T00:00:01.000Z";
      st.rows[0].updatedBy = "Reviewer";
    });
    eq("an anchor that split a <strong> in two is still only an anchor", out.status, 200);
  }

  /* and everything it does not exist for. Each of these changes exactly one
     thing about the document as it stands at that moment. */
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
  /* a reply to a thread already there IS an addition, so it is allowed */
  {
    const out = await reviewPut((st) => {
      st.comments[0].replies.push({ id: "rp1", author: "Reviewer", body: "agreed", createdAt: "2026-02-01T00:00:02.000Z" });
      st.comments[0].updatedAt = "2026-02-01T00:00:02.000Z";
    });
    eq("a reviewer may reply to a comment", out.status, 200);
  }
  /* and the editor is untouched by all of it */
  {
    const out = await reviewPut((st) => { st.rows[0].audioText = "Hello there, everyone"; }, editToken);
    eq("the editor can still change the script", out.status, 200);
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
  const join = async (payload) => json(await fetch(s7.base + "api/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }));
  const editToken = (await join({ pin: PIN })).token;
  const reviewToken = (await join({ pin: REVIEW_PIN })).token;

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

console.log("");
if (failures.length) {
  console.log("FAILED " + failures.length + " of " + (passed + failures.length) + " checks:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL PASS - " + passed + "/" + passed + " server checks");
process.exit(0);
