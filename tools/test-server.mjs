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

console.log("");
if (failures.length) {
  console.log("FAILED " + failures.length + " of " + (passed + failures.length) + " checks:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("ALL PASS - " + passed + "/" + passed + " server checks");
process.exit(0);
