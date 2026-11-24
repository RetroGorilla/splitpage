import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createRelayOwner } = require("../relay-owner.ts");

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), "splitpage-relay-owner-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const key = randomBytes(32);
  return {
    dir,
    secret: randomBytes(32).toString("base64url"),
    keyStore: {
      isEncryptionAvailable: () => true,
      encryptString(text) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decryptString(bytes) {
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
      }
    }
  };
}

async function serve(t, handle) {
  const server = createServer(handle);
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return "http://127.0.0.1:" + server.address().port;
}

test("the main process stores one encrypted pair, reopens it and clears it", async t => {
  const { dir, keyStore, secret } = store(t);
  const address = "https://relay.example";
  const owner = createRelayOwner(dir, keyStore);
  assert.deepEqual(owner.status(), { address: null });
  assert.equal(await owner.testConnection(), "not-configured");
  assert.equal(owner.save(address + "/", secret), "saved");
  assert.deepEqual(readdirSync(dir), ["relay-owner.enc"]);
  const bytes = readFileSync(join(dir, "relay-owner.enc"));
  assert.ok(!bytes.includes(secret) && !bytes.includes(address));
  assert.ok(JSON.parse(keyStore.decryptString(bytes)).secret === secret);
  const reopened = createRelayOwner(dir, keyStore);
  assert.deepEqual(reopened.status(), { address });
  assert.equal(reopened.clear(), true);
  assert.equal(reopened.clear(), true);
  assert.deepEqual(owner.status(), { address: null });
  assert.deepEqual(readdirSync(dir), []);
});

test("invalid addresses, invalid secrets and unavailable storage leave the previous relay intact", async t => {
  const { dir, keyStore, secret } = store(t);
  const address = "https://relay.example";
  const owner = createRelayOwner(dir, keyStore, () => { throw new Error(secret); });
  assert.equal(owner.save(address, secret), "saved");
  for (const invalid of ["bad", "ftp://relay.example", "http://relay.example", "https://relay.example/admin",
    "https://relay.example/#fragment", "https://relay.example/?query", "https://name@relay.example", "https://relay.example\\path"]) {
    assert.equal(owner.save(invalid, secret), "invalid-address");
  }
  for (const invalid of ["", " ", " extra", "extra ", "two\r\nlines"]) {
    assert.equal(owner.save(address, invalid), "invalid-secret");
  }
  const insecure = createRelayOwner(dir, { ...keyStore, getSelectedStorageBackend: () => "basic_text" });
  assert.equal(insecure.save(address, secret), "key-store-unavailable");
  const broken = createRelayOwner(dir, { ...keyStore, encryptString: () => { throw new Error(secret); } });
  assert.equal(broken.save("https://second.example", secret), "save-failed");
  assert.equal(await owner.testConnection(), "unreachable");
  assert.deepEqual(owner.status(), { address });
  assert.deepEqual(readdirSync(dir), ["relay-owner.enc"]);
});

test("owner HTTP sends a bearer on GET /api/status, answers 401, and masks response content", async t => {
  const { dir, keyStore, secret } = store(t);
  const seen = [];
  const address = await serve(t, (req, res) => {
    const matches = req.headers.authorization === "Bearer " + secret;
    seen.push([req.method, req.url, matches, req.headers.cookie]);
    res.writeHead(matches ? 200 : 401).end(secret);
  });
  const owner = createRelayOwner(dir, keyStore);
  assert.equal(owner.save(address, secret), "saved");
  assert.equal(await owner.testConnection(), "connected");
  assert.equal(owner.save(address, randomBytes(32).toString("base64url")), "saved");
  assert.equal(await owner.testConnection(), "wrong-secret");
  assert.deepEqual(seen, [["GET", "/api/status", true, undefined], ["GET", "/api/status", false, undefined]]);
});

test("the main client refuses cross-origin paths and follows no redirects", async t => {
  const { dir, keyStore, secret } = store(t);
  let forwarded = 0;
  const other = await serve(t, (_req, res) => { forwarded++; res.end(); });
  const address = await serve(t, (_req, res) => res.writeHead(302, { Location: other + "/api/status" }).end());
  const owner = createRelayOwner(dir, keyStore);
  assert.equal(owner.save(address, secret), "saved");
  assert.equal(await owner.testConnection(), "unreachable");
  assert.deepEqual(await owner.ownerRequest(other + "/api/status", { method: "GET" }), { kind: "unreachable" });
  assert.equal(forwarded, 0);
});
