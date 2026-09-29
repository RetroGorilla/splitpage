import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startFakeGoogle } from "./fake-google.mjs";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const gd = require(path.join(here, "..", "google-drive.js"));
const { createGoogleDrive, readClientConfig, isDriveId, isFileName, TOKEN_FILE, CLIENT_FILE, GOOGLE } = gd;

function fakeSafeStorage(available) {
  const key = 0x5a;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ key).toString("base64"), "utf8"),
    decryptString: (buf) => Buffer.from(Buffer.from(buf.toString("utf8"), "base64").map((b) => b ^ key)).toString("utf8")
  };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "splitpage-gdrive-")); }

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

async function setup(extra) {
  const fake = await startFakeGoogle();
  const dir = tmpDir();
  const opened = [];
  const drive = createGoogleDrive(Object.assign({
    testMode: true,
    testEndpointsBase: fake.base,
    userDataDir: dir,
    env: { SPLITPAGE_GOOGLE_CLIENT_ID: fake.clientId, SPLITPAGE_GOOGLE_CLIENT_SECRET: fake.clientSecret },
    safeStorage: fakeSafeStorage(true),
    openExternal: async (url) => { opened.push(url); },
    callbackTimeoutMs: 3000
  }, extra));
  let seen = 0;
  const waitForOpen = async () => {
    for (let i = 0; i < 200 && opened.length <= seen; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(opened.length > seen, "openExternal was called");
    seen = opened.length;
    return opened[opened.length - 1];
  };
  return { fake, dir, opened, drive, waitForOpen, done: async () => { drive.shutdown(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function signInThroughFake(t, override) {
  const p = t.drive.signIn();
  const url = await t.waitForOpen();
  const back = t.fake.approve(url, override);
  const res = await fetch(back);
  const page = await res.text();
  return { result: await p, page, status: res.status, authUrl: url };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("config: env, file (flat and Google's download shape), and nothing", () => {
  const dir = tmpDir();
  assert.equal(readClientConfig({ env: {}, userDataDir: dir }).configured, false);
  fs.writeFileSync(path.join(dir, CLIENT_FILE), JSON.stringify({ installed: { client_id: "9-abc.apps.googleusercontent.com", client_secret: "GOCSPX-x_y" } }));
  let c = readClientConfig({ env: {}, userDataDir: dir });
  assert.deepEqual([c.configured, c.source, c.clientId, c.clientSecret], [true, "file", "9-abc.apps.googleusercontent.com", "GOCSPX-x_y"]);
  fs.writeFileSync(path.join(dir, CLIENT_FILE), JSON.stringify({ client_id: "7-flat.apps.googleusercontent.com" }));
  c = readClientConfig({ env: {}, userDataDir: dir });
  assert.deepEqual([c.clientId, c.clientSecret], ["7-flat.apps.googleusercontent.com", ""]);
  c = readClientConfig({ env: { SPLITPAGE_GOOGLE_CLIENT_ID: "1-env.apps.googleusercontent.com" }, userDataDir: dir });
  assert.deepEqual([c.source, c.clientId], ["env", "1-env.apps.googleusercontent.com"]);
  fs.writeFileSync(path.join(dir, CLIENT_FILE), JSON.stringify({ client_id: "https://evil.example/x" }));
  assert.equal(readClientConfig({ env: {}, userDataDir: dir }).configured, false, "a URL is not a client id");
  fs.writeFileSync(path.join(dir, CLIENT_FILE), "{not json");
  assert.equal(readClientConfig({ env: {}, userDataDir: dir }).configured, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("endpoint override is refused outside test mode, and must be loopback", () => {
  assert.throws(() => createGoogleDrive({ testEndpointsBase: "http://127.0.0.1:1" }), /outside test mode/);
  assert.throws(() => createGoogleDrive({ testMode: true, testEndpointsBase: "https://evil.example" }), /loopback/);
  const d = createGoogleDrive({});
  assert.equal(d.endpoints, GOOGLE);
  assert.equal(d.endpoints.token, "https://oauth2.googleapis.com/token");
});

test("validators: Drive ids and names", () => {
  for (const ok of ["root", "1AbC_-xyz", "a".repeat(200)]) assert.ok(isDriveId(ok), ok);
  for (const bad of ["", "a".repeat(201), "../x", "a/b", "a?b", "a b", 5, null, "https://x"]) assert.ok(!isDriveId(bad), String(bad));
  for (const ok of ["Pilot.fountain", "A name with spaces.fdx"]) assert.ok(isFileName(ok));
  for (const bad of ["", ".", "..", " lead", "trail ", "a\nb", "x".repeat(256), 3]) assert.ok(!isFileName(bad), JSON.stringify(bad));
});

test("not configured: status says so and signIn answers NOT_CONFIGURED without listening", async () => {
  const dir = tmpDir();
  const opened = [];
  const d = createGoogleDrive({ userDataDir: dir, env: {}, safeStorage: fakeSafeStorage(true), openExternal: async (u) => opened.push(u) });
  const s = d.status();
  assert.equal(s.configured, false);
  assert.equal(s.clientFilePath, path.join(dir, CLIENT_FILE));
  assert.deepEqual(s.envVars, ["SPLITPAGE_GOOGLE_CLIENT_ID", "SPLITPAGE_GOOGLE_CLIENT_SECRET"]);
  assert.deepEqual(await d.signIn(), { ok: false, code: "NOT_CONFIGURED" });
  assert.equal(opened.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sign-in round trip: PKCE S256, loopback redirect, token stored only as the safeStorage blob", async () => {
  const t = await setup();
  try {
    const { result, page, status, authUrl } = await signInThroughFake(t);
    assert.equal(status, 200);
    assert.match(page, /return to Splitpage/);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.signedIn, true);
    assert.equal(result.persisted, true);
    assert.equal(result.email, "writer@example.com");
    const p = new URL(authUrl).searchParams;
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.equal(p.get("access_type"), "offline");
    assert.match(p.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(p.get("state").length >= 32);
    for (const k of Object.keys(result)) assert.ok(!/token/i.test(k), "status carries no token field: " + k);
    const blob = fs.readFileSync(path.join(t.dir, TOKEN_FILE));
    const secrets = t.fake.secrets();
    assert.ok(secrets.length >= 2);
    for (const f of walk(t.dir)) {
      const text = fs.readFileSync(f).toString("latin1");
      for (const s of secrets) assert.ok(!text.includes(s), "secret in plain text in " + f);
    }
    assert.ok(blob.length > 0);
    await assert.rejects(fetch(p.get("redirect_uri") + "/?code=x&state=" + p.get("state")));
    const again = createGoogleDrive({ testMode: true, testEndpointsBase: t.fake.base, userDataDir: t.dir,
      env: { SPLITPAGE_GOOGLE_CLIENT_ID: t.fake.clientId, SPLITPAGE_GOOGLE_CLIENT_SECRET: t.fake.clientSecret },
      safeStorage: fakeSafeStorage(true), openExternal: async () => {} });
    assert.equal(again.status().signedIn, true);
    const listed = await again.listFolder("scriptsFolder01");
    assert.equal(listed.ok, true, JSON.stringify(listed));
  } finally { await t.done(); }
});

test("a bad state is refused: no token, listener closed", async () => {
  const t = await setup();
  try {
    const { result, page, status } = await signInThroughFake(t, { state: "not-the-state" });
    assert.equal(status, 400);
    assert.match(page, /refused/);
    assert.deepEqual(result, { ok: false, code: "STATE_MISMATCH" });
    assert.equal(t.drive.status().signedIn, false);
    assert.ok(!fs.existsSync(path.join(t.dir, TOKEN_FILE)));
    assert.ok(!t.fake.log.includes("POST /token"), "no code exchange after a bad state");
  } finally { await t.done(); }
});

test("wrong Host header does not spend the callback; favicon probe is ignored", async () => {
  const t = await setup();
  try {
    const p = t.drive.signIn();
    const url = await t.waitForOpen();
    const back = new URL(t.fake.approve(url));
    const http = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: back.port, path: back.pathname + back.search, headers: { host: "evil.example:" + back.port } },
        (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 421);
    assert.equal((await fetch(back.origin + "/favicon.ico")).status, 404);
    const res = await fetch(back.href);
    assert.equal(res.status, 200);
    assert.equal((await p).ok, true);
  } finally { await t.done(); }
});

test("denied consent and timeout", async () => {
  const t = await setup({ callbackTimeoutMs: 300 });
  try {
    const denied = await signInThroughFake(t, { error: "access_denied" });
    assert.deepEqual(denied.result, { ok: false, code: "DENIED" });
    assert.deepEqual(await t.drive.signIn(), { ok: false, code: "TIMEOUT" });
    assert.equal(t.opened.length, 2);
    await assert.rejects(fetch(new URL(t.opened[1]).searchParams.get("redirect_uri") + "/"));
  } finally { await t.done(); }
});

test("sign-out (or quit) while waiting for the browser cancels the sign-in and closes the listener", async () => {
  const t = await setup();
  try {
    const p = t.drive.signIn();
    const url = await t.waitForOpen();
    const redirect = new URL(url).searchParams.get("redirect_uri");
    assert.equal(t.drive.status().signingIn, true);
    await t.drive.signOut();
    assert.deepEqual(await p, { ok: false, code: "CANCELLED" });
    await assert.rejects(fetch(redirect + "/"));
    assert.equal(t.drive.status().signingIn, false);
  } finally { await t.done(); }
});

test("concurrent signIn calls share one flow", async () => {
  const t = await setup();
  try {
    const a = t.drive.signIn();
    const b = t.drive.signIn();
    assert.equal(a, b);
    const url = await t.waitForOpen();
    await fetch(t.fake.approve(url));
    assert.equal((await a).ok, true);
    assert.equal(t.opened.length, 1);
  } finally { await t.done(); }
});

test("list, download (file and Google Doc export), upload new, update existing", async () => {
  const t = await setup();
  try {
    assert.equal((await signInThroughFake(t)).result.ok, true);
    const list = await t.drive.listFolder("scriptsFolder01");
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.equal(list.folder.name, "Scripts");
    assert.deepEqual(list.files.map((f) => f.name), ["Budget", "Notes", "Pilot.fountain"]);
    const root = await t.drive.listFolder("root");
    assert.deepEqual(root.files.map((f) => f.name), ["Scripts"]);
    assert.equal((await t.drive.listFolder("pilotFile01")).code, "NOT_A_FOLDER");
    assert.equal((await t.drive.listFolder("nope123")).code, "NOT_FOUND");
    assert.equal((await t.drive.listFolder("../etc")).code, "BAD_ARGS");

    const dl = await t.drive.download("pilotFile01");
    assert.equal(dl.ok, true);
    assert.equal(dl.file.name, "Pilot.fountain");
    assert.match(Buffer.from(dl.bytes).toString("utf8"), /fake scene/);
    const doc = await t.drive.download("gdoc01");
    assert.equal(Buffer.from(doc.bytes).toString("utf8"), "Notes exported as text.\n");
    assert.equal((await t.drive.download("sheet01")).code, "UNSUPPORTED");
    assert.equal((await t.drive.download("scriptsFolder01")).code, "IS_A_FOLDER");

    const up = await t.drive.upload({ parentId: "scriptsFolder01", name: "New.splitpage", bytes: new TextEncoder().encode("{\"v\":1}"), mimeType: "application/json" });
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.file.name, "New.splitpage");
    assert.equal(t.fake.files.get(up.file.id).data.toString(), "{\"v\":1}");
    const upd = await t.drive.upload({ fileId: up.file.id, bytes: "{\"v\":2}" });
    assert.equal(upd.ok, true);
    assert.equal(t.fake.files.get(up.file.id).data.toString(), "{\"v\":2}");
    assert.equal(t.fake.files.get(up.file.id).name, "New.splitpage");

    assert.equal((await t.drive.upload({ parentId: "scriptsFolder01", name: "a\nb", bytes: "x" })).code, "BAD_ARGS");
    assert.equal((await t.drive.upload({ parentId: "scripts/..", name: "a", bytes: "x" })).code, "BAD_ARGS");
    assert.equal((await t.drive.upload({ parentId: "scriptsFolder01", name: "a", bytes: 42 })).code, "BAD_ARGS");
    assert.equal((await t.drive.upload({ fileId: "x y", bytes: "x" })).code, "BAD_ARGS");
    assert.equal((await t.drive.upload(null)).code, "BAD_ARGS");
    const big = new Uint8Array(gd.MAX_FILE_BYTES + 1);
    assert.equal((await t.drive.upload({ parentId: "scriptsFolder01", name: "big", bytes: big })).code, "TOO_LARGE");

    assert.ok(t.fake.log.length > 0);
  } finally { await t.done(); }
});

test("an expired access token is refreshed with the stored refresh token", async () => {
  const t = await setup();
  try {
    assert.equal((await signInThroughFake(t)).result.ok, true);
    const before = t.fake.log.filter((l) => l === "POST /token").length;
    const fakeAt = t.fake.secrets().filter((s) => s.startsWith("ya29."));
    assert.ok(fakeAt.length >= 1);
    for (const at of fakeAt) await fetch(t.fake.base + "/revoke", { method: "POST", body: new URLSearchParams({ token: at }) });
    const list = await t.drive.listFolder("root");
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.equal(t.fake.log.filter((l) => l === "POST /token").length, before + 1);
  } finally { await t.done(); }
});

test("sign-out deletes the blob and revokes; a revoked refresh token signs out locally", async () => {
  const t = await setup();
  try {
    const { result } = await signInThroughFake(t);
    assert.equal(result.ok, true);
    const rt = t.fake.secrets().find((s) => s.startsWith("1//"));
    assert.ok(fs.existsSync(path.join(t.dir, TOKEN_FILE)));
    const out = await t.drive.signOut();
    assert.equal(out.ok, true);
    assert.equal(out.status.signedIn, false);
    assert.ok(!fs.existsSync(path.join(t.dir, TOKEN_FILE)));
    assert.ok(t.fake.isRevoked(rt));
    assert.equal((await t.drive.listFolder("root")).code, "SIGNED_OUT");

    const again = await signInThroughFake(t);
    assert.equal(again.result.ok, true);
    const rt2 = t.fake.secrets().find((s) => s.startsWith("1//") && s !== rt);
    await fetch(t.fake.base + "/revoke", { method: "POST", body: new URLSearchParams({ token: rt2 }) });
    for (const at of t.fake.secrets().filter((s) => s.startsWith("ya29."))) {
      await fetch(t.fake.base + "/revoke", { method: "POST", body: new URLSearchParams({ token: at }) });
    }
    assert.equal((await t.drive.listFolder("root")).code, "SIGNED_OUT");
    assert.equal(t.drive.status().signedIn, false);
    assert.ok(!fs.existsSync(path.join(t.dir, TOKEN_FILE)));
  } finally { await t.done(); }
});

test("safeStorage unavailable: signed in for the session only, nothing written", async () => {
  const t = await setup({ safeStorage: fakeSafeStorage(false) });
  try {
    const { result } = await signInThroughFake(t);
    assert.equal(result.ok, true);
    assert.equal(result.persisted, false);
    assert.equal(result.canPersist, false);
    assert.deepEqual(walk(t.dir), []);
    assert.equal((await t.drive.listFolder("root")).ok, true);
  } finally { await t.done(); }
});

test("packaging: every ./module main.js requires is in electron-builder.yml's files", () => {
  const main = fs.readFileSync(path.join(here, "..", "main.js"), "utf8");
  const yml = fs.readFileSync(path.join(here, "..", "electron-builder.yml"), "utf8");
  const listed = new Set([...yml.matchAll(/^\s*-\s+([A-Za-z0-9_.-]+\.js)\s*$/gm)].map((m) => m[1]));
  const required = [...main.matchAll(/require\("\.\/([A-Za-z0-9_-]+)(?:\.js)?"\)/g)].map((m) => m[1] + ".js");
  assert.ok(required.includes("google-drive.js"), "main.js requires ./google-drive");
  for (const f of required) assert.ok(listed.has(f), f + " is required by main.js but not in electron-builder.yml files");
});

let failed = 0;
for (const c of cases) {
  try { await c.fn(); console.log("ok   " + c.name); } catch (e) { failed++; console.log("FAIL " + c.name + "\n     " + (e && e.stack || e)); }
}
if (failed) { console.log(failed + " FAILED"); process.exit(1); }
console.log("ALL PASS (" + cases.length + ")");
