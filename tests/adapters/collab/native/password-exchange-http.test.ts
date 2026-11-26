import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { ownerRequests } from "../../../../collab-server/owner-http.ts";
import { MAX_DEVICE_CREDENTIALS_PER_SCRIPT, openWriter } from "../../../../collab-server/storage.ts";

test("recovery checks use a per-client budget separate from password exchange", async t => {
  const directory = mkdtempSync(join(tmpdir(), "splitpage-password-http-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  using db = openWriter(directory);
  const access = scriptAccess(db, () => true);
  const origin = "splitpage://app";
  const password = "Device capacity fixture";
  const { scriptId, guest } = await access.create(randomUUID(), Uint8Array.of(1), new Uint8Array(32), password);
  assert.ok(guest);
  const stored = access.readPassword(scriptId);
  assert.ok(stored);
  for (let count = 0; count < MAX_DEVICE_CREDENTIALS_PER_SCRIPT; count++) {
    const result = await access.exchange(scriptId, guest.token, password, stored);
    assert.equal(result.kind, "exchanged");
  }
  const handle = ownerRequests(undefined, 1024, {
    ...access,
    abandonCreation: access.abandon,
    revokeInvitation: access.revoke
  }, undefined, new Set([origin]));
  const server = createServer((request, response) => { void handle(request, response); });
  server.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/scripts/${scriptId}/password-exchange`;
  const authorization = "Bearer " + guest.token;
  for (let attempt = 0; attempt < 60; attempt++) {
    const target = attempt % 2 ? endpoint : endpoint.replace(scriptId, "unknown-script");
    assert.equal((await fetch(target, { method: "HEAD", headers: { Authorization: "Bearer invalid", Origin: origin } })).status, 403);
  }
  const limited = await fetch(endpoint, {
    method: "HEAD", headers: { Authorization: authorization, Origin: origin, "X-Forwarded-For": "192.0.2.1" }
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.equal(limited.headers.get("Access-Control-Allow-Origin"), origin);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password })
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "5");
  assert.deepEqual(await response.json(), { reason: "device-limit" });
});
