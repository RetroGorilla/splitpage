import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import type { InvitationRole } from "../../../../collab-server/access.ts";
import { backupRelay } from "../../../../collab-server/backup.ts";
import { DB_NAME, openWriter, verifyDatabase } from "../../../../collab-server/storage.ts";
import { seedRelaySession } from "./relay-harness.ts";
import { appendText, contentHash, ORIGIN, serverHarness, storedState, storedText } from "./server-harness.ts";

interface ExpectedInvitationEntry {
  readonly id: string;
  readonly label: string;
  readonly role: InvitationRole;
  readonly state: "active" | "revoked";
}

interface ExpectedStatusValues {
  readonly pictureBytes: number;
  readonly uploadsInFlight: number;
}

function issueRequest(role: InvitationRole, label: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, label })
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expectedKeys.length && expectedKeys.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasSensitiveValue(text: string, sensitiveValues: readonly string[]): boolean {
  return sensitiveValues.some(value => value.length > 0 && text.includes(value));
}

function parseSafeJson(raw: string, sensitiveValues: readonly string[], label: string): unknown {
  assert.equal(hasSensitiveValue(raw, sensitiveValues), false, `${label} must not disclose credentials or private values`);
  try {
    return JSON.parse(raw);
  } catch {
    assert.fail(`${label} must be valid JSON`);
  }
}

function assertStatusPayload(raw: string, expected: ExpectedStatusValues, sensitiveValues: readonly string[]): void {
  const parsed = parseSafeJson(raw, sensitiveValues, "status response");
  const valid = isPlainObject(parsed) &&
    hasExactKeys(parsed, [
      "connections", "uploadsInFlight", "storedBytes", "pictureBytes", "lastStorageFailure",
      "versionBytes", "lastVersionFailure", "lastBackupAt"
    ]) &&
    isPlainObject(parsed.connections) &&
    hasExactKeys(parsed.connections, ["total", "authenticated", "documents"]) &&
    isNonNegativeInteger(parsed.connections.total) &&
    isNonNegativeInteger(parsed.connections.authenticated) &&
    isNonNegativeInteger(parsed.connections.documents) &&
    parsed.uploadsInFlight === expected.uploadsInFlight &&
    isNonNegativeInteger(parsed.storedBytes) &&
    parsed.storedBytes > 0 &&
    parsed.pictureBytes === expected.pictureBytes &&
    parsed.lastStorageFailure === null &&
    isNonNegativeInteger(parsed.versionBytes) &&
    parsed.lastVersionFailure === null &&
    parsed.lastBackupAt === null;
  assert.equal(valid, true, "status response must match expected snapshot shape and values");
}

function assertInvitationListPayload(raw: string, expected: readonly ExpectedInvitationEntry[], sensitiveValues: readonly string[]): void {
  const parsed = parseSafeJson(raw, sensitiveValues, "invitation-list response");
  const valid = Array.isArray(parsed) &&
    parsed.length === expected.length &&
    parsed.every((entry, index) => {
      const target = expected[index];
      return target !== undefined &&
        isPlainObject(entry) &&
        hasExactKeys(entry, ["id", "label", "role", "state"]) &&
        entry.id === target.id &&
        entry.label === target.label &&
        entry.role === target.role &&
        entry.state === target.state;
    });
  assert.equal(valid, true, "invitation-list response must match expected invitation entries");
}

function readScriptIdPayload(raw: string, sensitiveValues: readonly string[], expectedScriptId?: string, expectCredentials = false): string {
  const parsed = parseSafeJson(raw, sensitiveValues, "script response");
  const record = isPlainObject(parsed) ? parsed : null;
  const scriptId = record?.scriptId;
  const isIssued = (value: unknown, role: InvitationRole): boolean =>
    isPlainObject(value) &&
    hasExactKeys(value, ["id", "token", "role"]) &&
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.token === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value.token) &&
    value.role === role;
  const valid = record !== null &&
    typeof scriptId === "string" &&
    /^[a-f0-9-]{36}$/.test(scriptId) &&
    (expectedScriptId === undefined || scriptId === expectedScriptId) &&
    (expectCredentials
      ? hasExactKeys(record, ["scriptId", "owner", "guest"]) && isIssued(record.owner, "owner") && isIssued(record.guest, "guest")
      : hasExactKeys(record, ["scriptId"]));
  assert.equal(valid, true, "script response must contain only the expected scriptId");
  return scriptId as string;
}

function readIssuedInvitationPayload(raw: string, sensitiveValues: readonly string[], expectedRole?: InvitationRole): { id: string; token: string; role: InvitationRole } {
  const parsed = parseSafeJson(raw, sensitiveValues, "issued invitation response");
  const record = isPlainObject(parsed) ? parsed : null;
  const id = record?.id;
  const token = record?.token;
  const role = record?.role;
  const valid = record !== null &&
    hasExactKeys(record, ["id", "token", "role"]) &&
    typeof id === "string" &&
    id.length > 0 &&
    typeof token === "string" &&
    /^[a-zA-Z0-9_-]{43}$/.test(token) &&
    (role === "owner" || role === "guest") &&
    (expectedRole === undefined || role === expectedRole);
  assert.equal(valid, true, "issued invitation response must contain only a valid id, role and token");
  return { id: id as string, token: token as string, role: role as InvitationRole };
}

function captureFailureOutput(run: () => void): string {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.equal(caught !== undefined, true, "expected failure path to throw");
  const message = caught instanceof Error ? caught.message : "";
  const stack = caught instanceof Error ? (caught.stack ?? "") : "";
  return `${message}\n${stack}\n${inspect(caught, { depth: 6 })}`;
}

test("owner commands initialize, issue, list, revoke and delete a shared script", { timeout: 25_000 }, async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const stateHash = contentHash(state);
  {
    using db = openWriter(kit.directory);
    db.prepare("INSERT INTO scripts (name, status) VALUES (?, 'pending')").run("pending-script");
  }
  const secret = randomBytes(32).toString("base64url");
  const wrong = randomBytes(32).toString("base64url");
  const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
  const id = randomUUID();
  const create = {
    method: "POST",
    headers: { "Idempotency-Key": id, "Splitpage-Content-SHA256": stateHash },
    body: Buffer.from(state)
  };
  assert.equal((await run.owner("scripts", create, null)).status, 401);
  assert.equal((await run.owner("scripts", create, wrong)).status, 401);
  assert.equal((await run.owner("scripts", { method: "POST", headers: { "Idempotency-Key": id }, body: Buffer.from(state) }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { method: "POST", headers: { "Idempotency-Key": id, "Splitpage-Content-SHA256": "not-hex" }, body: Buffer.from(state) }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { method: "POST", headers: { "Idempotency-Key": id, "Splitpage-Content-SHA256": contentHash(Buffer.alloc(0)) }, body: null }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { method: "POST", headers: { "Idempotency-Key": id, "Splitpage-Content-SHA256": contentHash(Uint8Array.of(255)) }, body: Uint8Array.of(255) }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { ...create, body: Uint8Array.of(255) }, secret)).status, 422);
  const ownerPort = await run.port();
  const oversizedInitial = await new Promise<{ status: number | undefined; connection: string | undefined }>((resolve, reject) => {
    let responseReceived = false;
    const upload = request({
      hostname: "127.0.0.1", port: ownerPort, path: "/api/scripts", method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": id,
        "Splitpage-Content-SHA256": "0".repeat(64),
        "Content-Length": "15000001"
      },
      signal: t.signal
    }, response => {
      responseReceived = true;
      response.resume();
      resolve({ status: response.statusCode, connection: response.headers.connection });
      upload.destroy();
    });
    upload.on("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (responseReceived && (code === "EPIPE" || code === "ECONNRESET")) return;
      reject(error);
    });
    upload.flushHeaders();
  });
  assert.deepEqual(oversizedInitial, { status: 413, connection: "close" });
  {
    using db = openWriter(kit.directory);
    assert.deepEqual(
      db.prepare("SELECT name FROM scripts ORDER BY name").all().map(row => row.name),
      ["pending-script", "test-script"]
    );
  }
  const [firstCreate, retryCreate] = await Promise.all([
    run.createScriptWithCredentials(id, state, secret),
    run.createScriptWithCredentials(id, state, secret)
  ]);
  assert.equal(firstCreate.scriptId, retryCreate.scriptId);
  assert.ok(firstCreate.owner && firstCreate.guest && retryCreate.owner && retryCreate.guest);
  const script = firstCreate.scriptId;
  assert.deepEqual(storedState(kit.directory, script), state);
  const oversized = await new Promise<{ status: number | undefined; connection: string | undefined }>((resolve, reject) => {
    const upload = request({
      hostname: "127.0.0.1", port: ownerPort, path: "/api/scripts", method: "POST",
      headers: { ...create.headers, Authorization: `Bearer ${secret}`, "Content-Length": "15000001" },
      signal: t.signal
    }, async response => {
      try {
        response.resume();
        resolve({ status: response.statusCode, connection: response.headers.connection });
      } catch (error) {
        reject(error);
      }
    });
    upload.on("error", reject);
    upload.flushHeaders();
  });
  assert.deepEqual(oversized, { status: 413, connection: "close" });
  assert.deepEqual(storedState(kit.directory, script), state);

  const path = `scripts/${script}/invitations`;
  const issue = issueRequest("guest", "Reader");
  const remove = { method: "DELETE" };
  assert.equal((await run.owner("scripts/pending-script/invitations", issue, secret)).status, 409);
  assert.equal((await run.owner(path, { method: "POST", body: "Reader" }, secret)).status, 400);
  assert.equal((await run.owner(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "admin", label: "Reader" }) }, secret)).status, 400);
  const issued = await run.owner(path, issue, secret);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  assert.equal(issued.headers.get("access-control-allow-origin"), null);
  const invitation = await issued.json() as { id: string; token: string; role: InvitationRole };
  assert.ok(/^[a-zA-Z0-9_-]{43}$/.test(invitation.token));
  assert.equal(invitation.role, "guest");
  const fresh = kit.copy(await run.port(), { kind: "empty" }, script, invitation.token);
  t.after(fresh.session.close);
  await kit.until(() => fresh.relay.status().firstSyncDone && fresh.text() === "word" || undefined);
  const checkEntryState = async (expectedState: string) => {
    const reply = await run.owner(path, {}, secret);
    assert.equal(reply.status, 200);
    const entries = await reply.json() as ExpectedInvitationEntry[];
    assert.deepEqual(entries.find(entry => entry.id === invitation.id), {
      id: invitation.id, label: "Reader", role: "guest", state: expectedState
    });
  };
  await checkEntryState("active");
  const picture = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
  const sha = createHash("sha256").update(picture).digest("hex");
  const picturePath = "scripts/" + script + "/pictures/" + sha;
  const upload = { method: "PUT", headers: { "Content-Type": "image/png" }, body: picture };
  assert.equal((await run.owner(picturePath, upload, secret)).status, 403);
  assert.equal((await run.owner(picturePath, upload, invitation.token)).status, 201);
  const download = await run.owner(picturePath, {}, invitation.token);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), picture);
  assert.equal((await run.owner(`invitations/${invitation.id}`, remove, secret)).status, 204);
  await checkEntryState("revoked");
  assert.equal((await run.owner(picturePath, {}, invitation.token)).status, 403);
  assert.equal((await run.owner(`scripts/${script}`, remove, secret)).status, 204);
  assert.equal((await run.owner(path, issue, secret)).status, 409);
  const touchedRetry = await run.createScriptWithCredentials(id, state, secret);
  assert.deepEqual(touchedRetry, { scriptId: script });
  await run.stop("clean");
  const restarted = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
  assert.deepEqual(await restarted.createScriptWithCredentials(id, state, secret), { scriptId: script });
  assert.equal((await restarted.owner(path, issue, secret)).status, 409);
  for (const process of [run, restarted]) {
    const logs = process.output() + process.errors();
    assert.ok(![secret, wrong, invitation.token, firstCreate.owner.token, firstCreate.guest.token, retryCreate.owner.token, retryCreate.guest.token, "Reader"].some(value => logs.includes(value)));
  }
});

test("rotating the management secret across relay restart rejects the retired secret and preserves data and invitations", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const initialSecret = randomBytes(32).toString("base64url");
  let replacementSecret = randomBytes(32).toString("base64url");
  while (replacementSecret === initialSecret) replacementSecret = randomBytes(32).toString("base64url");
  assert.equal(replacementSecret !== initialSecret, true, "replacement secret must differ from initial secret");
  kit.redact(initialSecret, replacementSecret);

  const picture = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
    Buffer.from("secret-rotation-picture", "utf8")
  ]);
  const pictureSha = createHash("sha256").update(picture).digest("hex");
  const secretValues: string[] = [initialSecret, replacementSecret];
  const privateNonLabelValues = () => [...secretValues, "Retired Attempt", pictureSha, "before-rotation", "after-rotation"];
  const allSensitiveValues = () => [...privateNonLabelValues(), "Before Rotation", "After Rotation"];

  const assertStatusNoLeak = async (response: Response, expectedStatus: number, label: string) => {
    assert.equal(response.status, expectedStatus, `${label} must return HTTP ${expectedStatus}`);
    const raw = await response.text();
    assert.equal(hasSensitiveValue(raw, allSensitiveValues()), false, `${label} must not disclose credentials or private values`);
  };

  const initial = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: initialSecret });
  const creationId = randomUUID();
  const stateHash = contentHash(state);
  const createdInitial = await initial.owner("scripts", {
    method: "POST",
    headers: { "Idempotency-Key": creationId, "Splitpage-Content-SHA256": stateHash },
    body: Buffer.from(state)
  }, initialSecret);
  assert.equal(createdInitial.status, 200);
  assert.equal(createdInitial.headers.get("cache-control") === "no-store", true, "script creation response must disable caching");
  const createdRaw = await createdInitial.text();
  const scriptId = readScriptIdPayload(createdRaw, allSensitiveValues(), undefined, true);
  const createdInitialParsed = JSON.parse(createdRaw) as {
    scriptId: string;
    owner: { id: string; token: string; role: InvitationRole };
    guest: { id: string; token: string; role: InvitationRole };
  };
  kit.redact(createdInitialParsed.owner.token, createdInitialParsed.guest.token);
  secretValues.push(createdInitialParsed.owner.token, createdInitialParsed.guest.token);

  const invitationsPath = `scripts/${scriptId}/invitations`;
  const issuedInitial = await initial.owner(invitationsPath, issueRequest("guest", "Before Rotation"), initialSecret);
  assert.equal(issuedInitial.status, 201);
  assert.equal(issuedInitial.headers.get("cache-control") === "no-store", true, "initial invitation issue response must disable caching");
  const existingInvite = readIssuedInvitationPayload(await issuedInitial.text(), allSensitiveValues(), "guest");
  kit.redact(existingInvite.token);
  secretValues.push(existingInvite.token);

  const writer = kit.copy(await initial.port(), { kind: "empty" }, scriptId, existingInvite.token);
  t.after(writer.session.close);
  await kit.until(() => (writer.relay.status().firstSyncDone && writer.text() === "word") || undefined);
  appendText(writer.session, " before-rotation", 4);
  await kit.until(() => (writer.pending() === 0 && storedText(kit.directory, scriptId) === "word before-rotation") || undefined);

  const picturePath = `scripts/${scriptId}/pictures/${pictureSha}`;
  const upload = await initial.owner(picturePath, {
    method: "PUT", headers: { "Content-Type": "image/png" }, body: picture
  }, existingInvite.token);
  await assertStatusNoLeak(upload, 201, "picture upload");

  await assertStatusNoLeak(await initial.owner("status", {}, replacementSecret), 401, "pre-rotation status with replacement secret");
  await assertStatusNoLeak(await initial.owner(invitationsPath, {}, replacementSecret), 401, "pre-rotation list with replacement secret");
  const statusBefore = await initial.owner("status", {}, initialSecret);
  assert.equal(statusBefore.status, 200);
  assert.equal(statusBefore.headers.get("cache-control") === "no-store", true, "pre-rotation status response must disable caching");
  assertStatusPayload(await statusBefore.text(), { pictureBytes: picture.length, uploadsInFlight: 0 }, allSensitiveValues());

  const initialExpectedList: ExpectedInvitationEntry[] = [
    { id: createdInitialParsed.owner.id, label: "Owner", role: "owner", state: "active" },
    { id: createdInitialParsed.guest.id, label: "Guest", role: "guest", state: "active" },
    { id: existingInvite.id, label: "Before Rotation", role: "guest", state: "active" }
  ];
  initialExpectedList.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const listBefore = await initial.owner(invitationsPath, {}, initialSecret);
  assert.equal(listBefore.status, 200);
  assert.equal(listBefore.headers.get("cache-control") === "no-store", true, "pre-rotation list response must disable caching");
  assertInvitationListPayload(await listBefore.text(), initialExpectedList, privateNonLabelValues());

  writer.close();
  assert.deepEqual(await initial.stop("clean"), { code: 0, exitSignal: null });
  const stateBeforeRotation = storedState(kit.directory, scriptId);

  const rotated = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: replacementSecret });
  await assertStatusNoLeak(await rotated.owner("status", {}, null), 401, "post-rotation status without credential");
  await assertStatusNoLeak(await rotated.owner(invitationsPath, {}, null), 401, "post-rotation list without credential");
  await assertStatusNoLeak(await rotated.owner("status", {}, initialSecret), 401, "post-rotation status with retired secret");
  await assertStatusNoLeak(await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": creationId, "Splitpage-Content-SHA256": stateHash }, body: Buffer.from(state) }, initialSecret), 401, "post-rotation retry with retired secret");
  await assertStatusNoLeak(await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": randomUUID(), "Splitpage-Content-SHA256": stateHash }, body: Buffer.from(state) }, initialSecret), 401, "post-rotation create with retired secret");
  await assertStatusNoLeak(await rotated.owner(invitationsPath, {}, initialSecret), 401, "post-rotation list with retired secret");
  await assertStatusNoLeak(await rotated.owner(invitationsPath, issueRequest("guest", "Retired Attempt"), initialSecret), 401, "post-rotation issue with retired secret");
  await assertStatusNoLeak(await rotated.owner(`invitations/${existingInvite.id}`, { method: "DELETE" }, initialSecret), 401, "post-rotation revoke with retired secret");
  await assertStatusNoLeak(await rotated.owner(`scripts/${scriptId}`, { method: "DELETE" }, initialSecret), 401, "post-rotation delete with retired secret");

  const statusAfter = await rotated.owner("status", {}, replacementSecret);
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.headers.get("cache-control") === "no-store", true, "post-rotation status response must disable caching");
  assertStatusPayload(await statusAfter.text(), { pictureBytes: picture.length, uploadsInFlight: 0 }, allSensitiveValues());

  const listAfter = await rotated.owner(invitationsPath, {}, replacementSecret);
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.headers.get("cache-control") === "no-store", true, "post-rotation list response must disable caching");
  assertInvitationListPayload(await listAfter.text(), initialExpectedList, privateNonLabelValues());

  const retryAfter = await rotated.owner("scripts", {
    method: "POST",
    headers: { "Idempotency-Key": creationId, "Splitpage-Content-SHA256": stateHash },
    body: Buffer.from(state)
  }, replacementSecret);
  assert.equal(retryAfter.status, 200);
  assert.equal(retryAfter.headers.get("cache-control") === "no-store", true, "post-rotation retry response must disable caching");
  readScriptIdPayload(await retryAfter.text(), allSensitiveValues(), scriptId, false);
  assert.equal(Buffer.from(storedState(kit.directory, scriptId)).equals(stateBeforeRotation), true, "stored script bytes must survive rotation unchanged");

  const issuedAfter = await rotated.owner(invitationsPath, issueRequest("guest", "After Rotation"), replacementSecret);
  assert.equal(issuedAfter.status, 201);
  assert.equal(issuedAfter.headers.get("cache-control") === "no-store", true, "post-rotation issue response must disable caching");
  const postInvite = readIssuedInvitationPayload(await issuedAfter.text(), allSensitiveValues(), "guest");
  kit.redact(postInvite.token);
  secretValues.push(postInvite.token);

  const rotatedPort = await rotated.port();
  const survivingPeer = kit.copy(rotatedPort, { kind: "empty" }, scriptId, existingInvite.token);
  const postPeer = kit.copy(rotatedPort, { kind: "empty" }, scriptId, postInvite.token);
  t.after(() => { survivingPeer.session.close(); postPeer.session.close(); });
  await kit.until(() => (
    survivingPeer.relay.status().firstSyncDone && survivingPeer.text() === "word before-rotation" &&
    postPeer.relay.status().firstSyncDone && postPeer.text() === "word before-rotation"
  ) || undefined);

  const downloadedBeforeRevoke = await rotated.owner(picturePath, {}, existingInvite.token);
  assert.equal(downloadedBeforeRevoke.status, 200);
  assert.equal(Buffer.from(await downloadedBeforeRevoke.arrayBuffer()).equals(picture), true, "pre-rotation picture bytes must remain downloadable");

  appendText(survivingPeer.session, " after-rotation", "word before-rotation".length);
  await kit.until(() => (
    postPeer.text() === "word before-rotation after-rotation" &&
    storedText(kit.directory, scriptId) === "word before-rotation after-rotation"
  ) || undefined);

  await assertStatusNoLeak(await rotated.owner(`invitations/${existingInvite.id}`, { method: "DELETE" }, replacementSecret), 204, "post-rotation revoke with replacement secret");
  const revokedEvent = await kit.until(() => survivingPeer.events.find(event => event.kind === "authentication-failed"));
  assert.equal(revokedEvent.reason === "access-removed", true, "revoked connection must close with access-removed");
  await assertStatusNoLeak(await rotated.owner(picturePath, {}, existingInvite.token), 403, "picture download with revoked invitation");
  const downloadedWithPostInvite = await rotated.owner(picturePath, {}, postInvite.token);
  assert.equal(downloadedWithPostInvite.status, 200);
  assert.equal(Buffer.from(await downloadedWithPostInvite.arrayBuffer()).equals(picture), true, "post-rotation invitation must download surviving picture bytes");

  const expectedList: ExpectedInvitationEntry[] = [
    { id: createdInitialParsed.owner.id, label: "Owner", role: "owner", state: "active" },
    { id: createdInitialParsed.guest.id, label: "Guest", role: "guest", state: "active" },
    { id: existingInvite.id, label: "Before Rotation", role: "guest", state: "revoked" },
    { id: postInvite.id, label: "After Rotation", role: "guest", state: "active" }
  ];
  expectedList.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const listFinal = await rotated.owner(invitationsPath, {}, replacementSecret);
  assert.equal(listFinal.status, 200);
  assert.equal(listFinal.headers.get("cache-control") === "no-store", true, "final list response must disable caching");
  assertInvitationListPayload(await listFinal.text(), expectedList, privateNonLabelValues());

  survivingPeer.close();
  postPeer.close();
  assert.deepEqual(await rotated.stop("clean"), { code: 0, exitSignal: null });
  assert.equal(storedText(kit.directory, scriptId) === "word before-rotation after-rotation", true, "post-rotation edit must persist across clean relay stop");

  const logSensitiveValues = allSensitiveValues();
  for (const process of [initial, rotated]) {
    const logs = process.output() + process.errors();
    assert.equal(hasSensitiveValue(logs, logSensitiveValues), false, "relay logs must not disclose credentials or private values");
  }
});

test("rotation failure diagnostics redact secrets while preserving static payload checks and safe startup errors", { timeout: 25_000 }, async t => {
  const sentinel = randomBytes(32).toString("base64url");
  const unexpectedField = `unexpected-${randomBytes(8).toString("hex")}`;
  const validStatus = {
    connections: { total: 0, authenticated: 0, documents: 0 },
    uploadsInFlight: 0,
    storedBytes: 128,
    pictureBytes: 42,
    lastStorageFailure: null,
    versionBytes: 0,
    lastVersionFailure: null,
    lastBackupAt: null
  };
  const expectedInvite: ExpectedInvitationEntry = { id: "invite-1", label: "Editor", role: "guest", state: "active" };

  const failureCases: readonly { readonly run: () => void; readonly expectedMessage: string; readonly hidden: readonly string[] }[] = [
    {
      run: () => assertInvitationListPayload(JSON.stringify([{ ...expectedInvite, token: sentinel }]), [expectedInvite], [sentinel]),
      expectedMessage: "invitation-list response must not disclose credentials or private values",
      hidden: [sentinel]
    },
    {
      run: () => assertInvitationListPayload(`[{"broken":${sentinel}`, [expectedInvite], [sentinel]),
      expectedMessage: "invitation-list response must not disclose credentials or private values",
      hidden: [sentinel]
    },
    {
      run: () => assertInvitationListPayload(`{malformed-${unexpectedField}`, [expectedInvite], [sentinel]),
      expectedMessage: "invitation-list response must be valid JSON",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => assertInvitationListPayload(JSON.stringify([{ ...expectedInvite, extra: unexpectedField }]), [expectedInvite], [sentinel]),
      expectedMessage: "invitation-list response must match expected invitation entries",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => assertInvitationListPayload(JSON.stringify([{ ...expectedInvite, state: "revoked" }]), [expectedInvite], [sentinel]),
      expectedMessage: "invitation-list response must match expected invitation entries",
      hidden: [sentinel]
    },
    {
      run: () => assertStatusPayload(JSON.stringify({ ...validStatus, leaked: sentinel }), { pictureBytes: 42, uploadsInFlight: 0 }, [sentinel]),
      expectedMessage: "status response must not disclose credentials or private values",
      hidden: [sentinel]
    },
    {
      run: () => assertStatusPayload(`{"broken":${sentinel}`, { pictureBytes: 42, uploadsInFlight: 0 }, [sentinel]),
      expectedMessage: "status response must not disclose credentials or private values",
      hidden: [sentinel]
    },
    {
      run: () => assertStatusPayload(`{malformed-${unexpectedField}`, { pictureBytes: 42, uploadsInFlight: 0 }, [sentinel]),
      expectedMessage: "status response must be valid JSON",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => assertStatusPayload(JSON.stringify({ ...validStatus, extra: unexpectedField }), { pictureBytes: 42, uploadsInFlight: 0 }, [sentinel]),
      expectedMessage: "status response must match expected snapshot shape and values",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => assertStatusPayload(JSON.stringify({ ...validStatus, pictureBytes: 99 }), { pictureBytes: 42, uploadsInFlight: 0 }, [sentinel]),
      expectedMessage: "status response must match expected snapshot shape and values",
      hidden: [sentinel]
    },
    {
      run: () => readScriptIdPayload(`{"scriptId":"${sentinel}"}`, [sentinel]),
      expectedMessage: "script response must not disclose credentials or private values",
      hidden: [sentinel]
    },
    {
      run: () => readScriptIdPayload(`{malformed-${unexpectedField}`, [sentinel]),
      expectedMessage: "script response must be valid JSON",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => readScriptIdPayload(JSON.stringify({ scriptId: randomUUID(), extra: unexpectedField }), [sentinel]),
      expectedMessage: "script response must contain only the expected scriptId",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => readIssuedInvitationPayload(JSON.stringify({ id: "i1", role: "guest", token: "a".repeat(43), secret: sentinel }), [sentinel]),
      expectedMessage: "issued invitation response must not disclose credentials or private values",
      hidden: [sentinel]
    },
    {
      run: () => readIssuedInvitationPayload(`{malformed-${unexpectedField}`, [sentinel]),
      expectedMessage: "issued invitation response must be valid JSON",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => readIssuedInvitationPayload(JSON.stringify({ id: "i1", role: "guest", token: "a".repeat(43), extra: unexpectedField }), [sentinel]),
      expectedMessage: "issued invitation response must contain only a valid id, role and token",
      hidden: [sentinel, unexpectedField]
    }
  ];

  for (const failureCase of failureCases) {
    const captured = captureFailureOutput(failureCase.run);
    assert.equal(captured.includes(failureCase.expectedMessage), true, "failure output must include static diagnostic");
    assert.equal(hasSensitiveValue(captured, failureCase.hidden), false, "failure output must not leak sentinel or unexpected field values");
  }

  const kit = serverHarness(t);
  const retiredSentinel = randomBytes(32).toString("base64url");
  kit.redact(retiredSentinel);
  const leakyCrashPath = join(kit.directory, "leaky-startup-crash.mjs");
  writeFileSync(
    leakyCrashPath,
    "process.stderr.write('safe-startup-context Bearer ' + (process.env.SPLITPAGE_MANAGEMENT_SECRET ?? '') + ' ' + (process.env.TEST_RETIRED_SENTINEL ?? '') + '\\n'); process.exit(1);\n"
  );
  const leakyRun = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: sentinel, TEST_RETIRED_SENTINEL: retiredSentinel }, pathToFileURL(leakyCrashPath));
  let leakyError: unknown;
  try {
    await leakyRun.port();
  } catch (error) {
    leakyError = error;
  }
  assert.equal(leakyError instanceof Error, true, "exited relay must reject port() with an Error");
  const leakyDiagnostic = `${(leakyError as Error).message}\n${(leakyError as Error).stack ?? ""}\n${inspect(leakyError, { depth: 6 })}`;
  assert.equal(hasSensitiveValue(leakyDiagnostic, [sentinel, retiredSentinel]), false, "startup failure diagnostic must redact secrets from child stderr");
  assert.equal((leakyError as Error).message.includes("[redacted]"), true, "startup failure diagnostic must mark redacted secret");
  assert.equal((leakyError as Error).message.includes("safe-startup-context"), true, "startup failure diagnostic must retain safe stderr context");

  const safeCrashPath = join(kit.directory, "safe-startup-crash.mjs");
  writeFileSync(safeCrashPath, "process.stderr.write('safe-only-startup-error\\n'); process.exit(1);\n");
  const safeRun = kit.launch({}, pathToFileURL(safeCrashPath));
  let safeError: unknown;
  try {
    await safeRun.port();
  } catch (error) {
    safeError = error;
  }
  assert.equal(safeError instanceof Error, true, "safe startup crash must reject port() with an Error");
  assert.equal((safeError as Error).message, "Relay exited before listening. safe-only-startup-error\n");
});

function seedLegacyDatabase(directory: string, version: 1 | 2 | 3 | 4, options: {
  script: string;
  state: Uint8Array;
  invitationId: string;
  tokenHash: Buffer;
  creationId: string;
  createdScript?: string;
  picture?: { sha: string; bytes: Buffer };
}): void {
  const path = join(directory, DB_NAME);
  using db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA application_id=1397771348");
  db.exec(`
    CREATE TABLE documents (name TEXT PRIMARY KEY NOT NULL, state BLOB NOT NULL) STRICT;
    CREATE TABLE scripts (name TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'deleted'))) STRICT;
    CREATE TABLE invitations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL REFERENCES scripts(name), label TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32), revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))) STRICT;
  `);
  if (version >= 2) {
    db.exec("CREATE TABLE creations (id TEXT PRIMARY KEY NOT NULL, script TEXT NOT NULL UNIQUE REFERENCES scripts(name)) STRICT");
  }
  if (version >= 3) {
    db.exec("CREATE TABLE script_pictures (script TEXT NOT NULL REFERENCES scripts(name), sha TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT NOT NULL, PRIMARY KEY (script, sha)) STRICT; CREATE INDEX script_pictures_sha ON script_pictures(sha)");
  }
  db.prepare("INSERT INTO scripts VALUES (?, 'active')").run(options.script);
  db.prepare("INSERT INTO documents VALUES (?, ?)").run(options.script, options.state);
  db.prepare("INSERT INTO invitations (id, script, label, token_hash) VALUES (?, ?, ?, ?)").run(
    options.invitationId, options.script, "test invitation", options.tokenHash
  );
  if (version >= 2 && options.createdScript) {
    db.prepare("INSERT INTO scripts VALUES (?, 'active')").run(options.createdScript);
    db.prepare("INSERT INTO documents VALUES (?, ?)").run(options.createdScript, options.state);
    db.prepare("INSERT INTO creations VALUES (?, ?)").run(options.creationId, options.createdScript);
  }
  if (version >= 3 && options.picture) {
    const picturesDir = join(directory, "pictures");
    mkdirSync(picturesDir, { recursive: true });
    writeFileSync(join(picturesDir, options.picture.sha), options.picture.bytes);
    db.prepare("INSERT INTO script_pictures VALUES (?, ?, ?, 'image/png')").run(
      options.script, options.picture.sha, options.picture.bytes.length
    );
  }
  if (version === 4) {
    db.exec(`ALTER TABLE scripts ADD COLUMN untouched INTEGER NOT NULL DEFAULT 0 CHECK (untouched IN (0, 1));
      ALTER TABLE creations ADD COLUMN content_hash BLOB CHECK (content_hash IS NULL OR length(content_hash) = 32);
      ALTER TABLE invitations ADD COLUMN role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('owner', 'guest'));
      ALTER TABLE invitations ADD COLUMN creation_id TEXT REFERENCES creations(id)`);
    db.prepare("UPDATE creations SET content_hash = ? WHERE id = ?")
      .run(createHash("sha256").update(options.state).digest(), options.creationId);
    db.prepare("UPDATE invitations SET script = ?, role = 'owner', creation_id = ? WHERE id = ?")
      .run(options.createdScript ?? options.script, options.creationId, options.invitationId);
    db.prepare("UPDATE scripts SET untouched = 1 WHERE name = ?").run(options.createdScript ?? options.script);
  }
  db.exec(`PRAGMA user_version=${version}`);
  assert.equal(verifyDatabase(db), version);
}

test("storage v4 upgrades all populated tables to v8 atomically", async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const dir = join(kit.directory, "atomic-v4");
  mkdirSync(dir);
  const picture = Buffer.of(42);
  const sha = createHash("sha256").update(picture).digest("hex");
  seedLegacyDatabase(dir, 4, {
    script: "original", state, invitationId: "owner-link", tokenHash: Buffer.alloc(32, 1),
    creationId: "creation", createdScript: "created", picture: { sha, bytes: picture }
  });
  const backup = await backupRelay({ SPLITPAGE_DATA_DIR: dir });
  using archive = new DatabaseSync(join(dir, "backups", backup, DB_NAME), { readOnly: true });
  assert.equal(verifyDatabase(archive), 4);
  const path = join(dir, DB_NAME);
  using before = new DatabaseSync(path);
  before.exec(`INSERT INTO invitations (id, script, label, token_hash) VALUES ('guest-link', 'original', 'Guest', zeroblob(32));
    CREATE TABLE version_chunks (conflict TEXT)`);
  const orderedRows = () => [
    before.prepare("SELECT id, script, label, token_hash, revoked, role, creation_id FROM invitations ORDER BY id").all(),
    ...["creations", "scripts", "script_pictures"].map(table => before.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  ];
  const expected = orderedRows();
  assert.throws(() => openWriter(dir).close(), /could not be opened or initialized/);
  assert.equal(verifyDatabase(before), 4);
  assert.equal(before.prepare("SELECT sql FROM sqlite_schema WHERE name = 'versions'").get(), undefined);
  before.exec("DROP TABLE version_chunks");
  const run = kit.launch({ SPLITPAGE_DATA_DIR: dir }, new URL("./server-process.ts", import.meta.url));
  await run.port();
  assert.equal(verifyDatabase(before), 8);
  assert.deepEqual(orderedRows(), expected);
  assert.equal(before.prepare("SELECT kind FROM invitations WHERE id = 'guest-link'").get()?.kind, "link");
  assert.deepEqual(storedState(dir, "created"), state);
  assert.deepEqual(storedState(dir, "original"), state);
  assert.equal(before.prepare("SELECT count(*) AS count FROM versions").get()?.count, 0);
  assert.equal(before.prepare("SELECT count(*) AS count FROM version_editors").get()?.count, 0);
});

for (const version of [1, 2, 3] as const) {
  test("the relay upgrades populated storage from version " + version, { timeout: 25_000 }, async t => {
    const kit = serverHarness(t);
    const previous = "previous-script";
    const tempSession = kit.seed(previous);
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    kit.redact(token);
    const tokenHash = createHash("sha256").update(token).digest();
    const creationId = randomUUID();
    const createdScript = version >= 2 ? randomUUID() : undefined;
    const pictureBytes = Buffer.concat([
      Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
      Buffer.from("upgrade-v" + version, "utf8")
    ]);
    const pictureSha = createHash("sha256").update(pictureBytes).digest("hex");
    const legacyDir = join(kit.directory, "legacy-v" + version);
    mkdirSync(legacyDir, { recursive: true });
    seedLegacyDatabase(legacyDir, version, {
      script: previous,
      state: tempSession,
      invitationId: id,
      tokenHash,
      creationId,
      ...(createdScript ? { createdScript } : {}),
      ...(version === 3 ? { picture: { sha: pictureSha, bytes: pictureBytes } } : {})
    });

    const env = { SPLITPAGE_DATA_DIR: legacyDir };
    const previousBackup = await backupRelay(env);
    const run = kit.launch({ SPLITPAGE_DATA_DIR: legacyDir }, new URL("./server-process.ts", import.meta.url));
    const response = await run.owner("scripts/previous-script/invitations");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id, label: "test invitation", role: "guest", state: "active" }]);
    assert.deepEqual(storedState(legacyDir, previous), tempSession);

    assert.equal((await run.owner("scripts/previous-script/reset", { method: "POST" }, token)).status, 403);
    assert.equal((await run.owner("scripts/previous-script", { method: "DELETE" }, token)).status, 403);

    const peer = kit.copy(await run.port(), { kind: "empty" }, previous, token);
    await kit.until(() => peer.relay.status().firstSyncDone && peer.text() === "word" || undefined);
    if (version === 3) {
      const pic = await run.owner(`scripts/${previous}/pictures/${pictureSha}`, {}, token);
      assert.equal(pic.status, 200);
      assert.deepEqual(Buffer.from(await pic.arrayBuffer()), pictureBytes);
    }

    const ownerIssued = await run.owner("scripts/previous-script/invitations", issueRequest("owner", "Upgraded Owner"));
    assert.equal(ownerIssued.status, 201);
    const ownerCred = await ownerIssued.json() as { id: string; token: string; role: InvitationRole };
    assert.equal(ownerCred.role, "owner");
    const resetViaOwner = await run.owner("scripts/previous-script/reset", { method: "POST" }, ownerCred.token);
    assert.equal(resetViaOwner.status, 200);

    const restored = await run.createScriptWithCredentials(creationId, tempSession);
    if (createdScript !== undefined) {
      assert.deepEqual(restored, { scriptId: createdScript });
    } else {
      assert.ok(restored.owner && restored.guest);
    }
    assert.deepEqual(storedState(legacyDir, restored.scriptId), tempSession);
    const currentBackup = await backupRelay(env);
    for (const [file, expectedVersion] of [[previousBackup, version], [currentBackup, 8]] as const) {
      using copy = new DatabaseSync(join(legacyDir, "backups", file, DB_NAME), { readOnly: true });
      assert.equal(verifyDatabase(copy), expectedVersion);
      if (expectedVersion >= 2) {
        assert.equal(copy.prepare("SELECT script FROM creations WHERE id = ?").get(creationId)?.script, restored.scriptId);
      }
    }
    using live = new DatabaseSync(join(legacyDir, DB_NAME), { readOnly: true });
    assert.equal(verifyDatabase(live), 8);
    assert.equal(live.prepare("SELECT count(*) AS count FROM script_pictures").get()?.count, version === 3 ? 1 : 0);
  });
}

test("storage upgrade from version 3 rolls back atomically on failure", async t => {
  const kit = serverHarness(t);
  const state = kit.seed();
  const dir = join(kit.directory, "atomic-v3");
  mkdirSync(dir, { recursive: true });
  seedLegacyDatabase(dir, 3, {
    script: "s1",
    state,
    invitationId: randomUUID(),
    tokenHash: randomBytes(32),
    creationId: randomUUID(),
    createdScript: randomUUID()
  });
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql.includes("ADD COLUMN creation_id")) throw new Error("injected upgrade failure");
    return exec.call(this, sql);
  });
  assert.throws(() => openWriter(dir).close(), /could not be opened or initialized/);
  using unchanged = new DatabaseSync(join(dir, DB_NAME), { readOnly: true });
  assert.equal(verifyDatabase(unchanged), 3);
});

test("HEAD checks a guest link, marks first use synchronously, and keeps invitation tokens out of the logs",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const secret = randomBytes(32).toString("base64url");
    const deployment = "guest-link-fixture";
    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret, SPLITPAGE_DEPLOYMENT_ID: deployment });
    const created = await run.createScriptWithCredentials(randomUUID(), kit.seed(), secret);
    assert.ok(created.owner && created.guest);
    const { scriptId, owner, guest } = created;
    const script = `scripts/${scriptId}`;
    const status = async () => {
      const response = await run.owner("scripts", {}, secret);
      assert.equal(response.status, 200);
      const scripts = await response.json() as { id: string; untouched: boolean }[];
      return scripts.find(item => item.id === scriptId)?.untouched;
    };
    const check = (token: string) => run.owner(script + "/link", { method: "HEAD" }, token);
    assert.equal(await status(), true);

    const accepted = await check(guest.token);
    assert.equal(accepted.status, 204);
    assert.equal(accepted.headers.get("Splitpage-Deployment"), deployment);
    assert.equal(accepted.headers.get("Cache-Control"), "no-store");
    assert.equal(await status(), false);

    const reset = await run.owner(script + "/reset", { method: "POST" }, owner.token);
    assert.equal(reset.status, 200);
    const replacement = await reset.json() as { token: string };
    assert.equal((await check(guest.token)).status, 403);
    assert.equal((await check(replacement.token)).status, 204);
    assert.equal((await run.owner(script, { method: "DELETE" }, owner.token)).status, 204);
    assert.equal((await check(replacement.token)).status, 403);
    await run.stop("clean");
    const logs = run.output() + run.errors();
    for (const token of [secret, guest.token, owner.token, replacement.token]) {
      assert.equal(logs.includes(token), false, "relay logs do not contain credentials");
    }
  });

test("guest refusal, reset link preserving two owners, old/new guest tokens, owner delete and no CORS on owner endpoints",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const state = kit.seed();
    const secret = randomBytes(32).toString("base64url");
    kit.redact(secret);
    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
    const port = await run.port();

    const created = await run.createScriptWithCredentials(randomUUID(), state, secret);
    assert.ok(created.owner && created.guest);
    const other = await run.createScriptWithCredentials(randomUUID(), state, secret);
    assert.ok(other.owner && other.guest);
    const scriptId = created.scriptId;

    const owner2Reply = await run.owner(`scripts/${scriptId}/invitations`, issueRequest("owner", "Second Desktop"), secret);
    assert.equal(owner2Reply.status, 201);
    const owner2 = await owner2Reply.json() as { id: string; token: string; role: InvitationRole };
    assert.equal(owner2.role, "owner");
    kit.redact(owner2.token);

    for (const [path, init, cred, expected] of [
      [`scripts/${scriptId}/reset`, { method: "POST" }, created.guest.token, 403],
      [`scripts/${scriptId}`, { method: "DELETE" }, created.guest.token, 403],
      [`scripts/${scriptId}/reset`, { method: "POST" }, other.owner.token, 401],
      [`scripts/${scriptId}`, { method: "DELETE" }, other.owner.token, 401],
      ["scripts", { method: "GET" }, created.owner.token, 401],
      [`scripts/${scriptId}/invitations`, { method: "GET" }, created.owner.token, 401],
      [`scripts/${scriptId}/invitations`, issueRequest("guest", "Blocked"), created.owner.token, 401]
    ] as const) {
      const refused = await run.owner(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Origin: ORIGIN } }, cred);
      assert.equal(refused.status, expected, path);
      assert.equal(refused.headers.get("access-control-allow-origin"), null, path);
    }

    const preflight = await fetch(`http://127.0.0.1:${port}/api/scripts/${scriptId}/reset`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" }
    });
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);

    const ownerConn1 = kit.copy(port, { kind: "empty" }, scriptId, created.owner.token);
    const ownerConn2 = kit.copy(port, { kind: "empty" }, scriptId, owner2.token);
    const guestConn1 = kit.copy(port, { kind: "empty" }, scriptId, created.guest.token);
    await kit.until(() => (
      ownerConn1.relay.status().firstSyncDone && ownerConn1.text() === "word" &&
      ownerConn2.relay.status().firstSyncDone && ownerConn2.text() === "word" &&
      guestConn1.relay.status().firstSyncDone && guestConn1.text() === "word"
    ) || undefined);

    const picture = Buffer.concat([
      Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
      Buffer.from("reset-pic", "utf8")
    ]);
    const pictureSha = createHash("sha256").update(picture).digest("hex");
    const picturePath = `scripts/${scriptId}/pictures/${pictureSha}`;
    assert.equal((await run.owner(picturePath, { method: "PUT", headers: { "Content-Type": "image/png" }, body: picture }, created.guest.token)).status, 201);

    const resetResponse = await run.owner(`scripts/${scriptId}/reset`, { method: "POST", headers: { Origin: ORIGIN } }, created.owner.token);
    assert.equal(resetResponse.status, 200);
    assert.equal(resetResponse.headers.get("cache-control"), "no-store");
    assert.equal(resetResponse.headers.get("access-control-allow-origin"), null);
    const newGuest = await resetResponse.json() as { id: string; token: string; role: InvitationRole };
    assert.equal(newGuest.role, "guest");
    assert.match(newGuest.token, /^[a-zA-Z0-9_-]{43}$/);
    assert.notEqual(newGuest.token, created.guest.token);
    kit.redact(newGuest.token);

    const guestDisconnected = await kit.until(() => guestConn1.events.find(event => event.kind === "authentication-failed"));
    assert.equal(guestDisconnected.reason, "access-removed");

    assert.equal(ownerConn1.events.some(event => event.kind === "authentication-failed"), false);
    assert.equal(ownerConn2.events.some(event => event.kind === "authentication-failed"), false);
    assert.equal(ownerConn1.relay.status().connected, true);
    assert.equal(ownerConn2.relay.status().connected, true);

    appendText(ownerConn1.session, " one", 4);
    await kit.until(() => ownerConn2.text() === "word one" || undefined);
    appendText(ownerConn2.session, " two", 8);
    await kit.until(() => ownerConn1.text() === "word one two" || undefined);

    const oldGuestRetry = kit.copy(port, { kind: "empty" }, scriptId, created.guest.token);
    const oldGuestRefused = await kit.until(() => oldGuestRetry.events.find(event => event.kind === "authentication-failed"));
    assert.equal(oldGuestRefused.reason, "access-removed");
    assert.equal((await run.owner(picturePath, {}, created.guest.token)).status, 403);

    const newGuestConn = kit.copy(port, { kind: "empty" }, scriptId, newGuest.token);
    await kit.until(() => (newGuestConn.relay.status().firstSyncDone && newGuestConn.text() === "word one two") || undefined);
    assert.equal((await run.owner(picturePath, {}, newGuest.token)).status, 200);

    const deleteViaOwner = await run.owner(`scripts/${scriptId}`, { method: "DELETE", headers: { Origin: ORIGIN } }, owner2.token);
    assert.equal(deleteViaOwner.status, 204);
    assert.equal(deleteViaOwner.headers.get("access-control-allow-origin"), null);

    for (const conn of [ownerConn1, ownerConn2, newGuestConn]) {
      const closed = await kit.until(() => conn.events.find(event => event.kind === "authentication-failed"));
      assert.equal(closed.reason, "access-removed");
    }

    assert.equal((await run.owner(`scripts/${scriptId}`, { method: "DELETE" }, owner2.token)).status, 204);
    assert.equal((await run.owner(`scripts/${scriptId}`, { method: "DELETE" }, created.owner.token)).status, 204);
    assert.equal((await run.owner(`scripts/${scriptId}`, { method: "DELETE" }, secret)).status, 204);
    assert.equal((await run.owner(`scripts/${scriptId}`, { method: "DELETE" }, newGuest.token)).status, 403);
    assert.equal((await run.owner(`scripts/${scriptId}/reset`, { method: "POST" }, owner2.token)).status, 409);

    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    const logs = run.output() + run.errors();
    for (const sensitive of [secret, created.owner.token, created.guest.token, owner2.token, newGuest.token, other.owner.token, other.guest.token]) {
      assert.equal(logs.includes(sensitive), false);
    }
  }
);

test("creation retry, untouched rules, different-hash refusal, abandon and second-owner protection",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const state1 = kit.seed();
    const state1Hash = contentHash(state1);
    const diffDoc = (() => {
      const session = seedRelaySession();
      try {
        appendText(session, " different", 4);
        return session.encodeState();
      } finally {
        session.close();
      }
    })();
    const diffHash = contentHash(diffDoc);
    assert.notEqual(diffHash, state1Hash);
    const secret = randomBytes(32).toString("base64url");
    kit.redact(secret);
    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
    const port = await run.port();

    const untouchedId = randomUUID();
    const first = await run.createScriptWithCredentials(untouchedId, state1, secret);
    assert.ok(first.owner && first.guest);
    const invitationsBeforeMismatch = await (await run.owner(`scripts/${first.scriptId}/invitations`, {}, secret)).json();

    const mismatchedHash = await run.owner("scripts", {
      method: "POST",
      headers: { "Idempotency-Key": untouchedId, "Splitpage-Content-SHA256": diffHash },
      body: Buffer.from(diffDoc)
    }, secret);
    assert.equal(mismatchedHash.status, 409);
    assert.deepEqual(storedState(kit.directory, first.scriptId), state1);
    assert.deepEqual(
      await (await run.owner(`scripts/${first.scriptId}/invitations`, {}, secret)).json(),
      invitationsBeforeMismatch
    );

    assert.equal((await run.owner(`scripts/${first.scriptId}/reset`, { method: "POST" }, first.guest.token)).status, 403);

    const retried = await run.createScriptWithCredentials(untouchedId, state1, secret);
    assert.equal(retried.scriptId, first.scriptId);
    assert.ok(retried.owner && retried.guest);
    assert.notEqual(retried.owner.id, first.owner.id);
    assert.notEqual(retried.guest.id, first.guest.id);

    for (const staleToken of [first.owner.token, first.guest.token]) {
      const attempt = kit.copy(port, { kind: "empty" }, first.scriptId, staleToken);
      const refused = await kit.until(() => attempt.events.find(event => event.kind === "authentication-failed"));
      assert.equal(refused.reason, "invitation-revoked");
    }

    const wsTouched = kit.copy(port, { kind: "empty" }, first.scriptId, retried.guest.token);
    await kit.until(() => (wsTouched.relay.status().firstSyncDone && wsTouched.text() === "word") || undefined);
    const afterWsRetry = await run.createScriptWithCredentials(untouchedId, state1, secret);
    assert.deepEqual(afterWsRetry, { scriptId: first.scriptId });
    assert.equal((await run.owner(`creations/${untouchedId}`, { method: "DELETE" }, secret)).status, 409);
    assert.equal(wsTouched.relay.status().connected, true);

    const httpTouchId = randomUUID();
    const httpCreated = await run.createScriptWithCredentials(httpTouchId, state1, secret);
    assert.ok(httpCreated.guest);
    const picCheck = await run.owner(`scripts/${httpCreated.scriptId}/pictures/${"0".repeat(64)}`, {}, httpCreated.guest.token);
    assert.equal(picCheck.status, 404);
    assert.deepEqual(await run.createScriptWithCredentials(httpTouchId, state1, secret), { scriptId: httpCreated.scriptId });
    assert.equal((await run.owner(`creations/${httpTouchId}`, { method: "DELETE" }, secret)).status, 409);
    const afterHttpAbandon = kit.copy(port, { kind: "empty" }, httpCreated.scriptId, httpCreated.guest.token);
    await kit.until(() => (afterHttpAbandon.relay.status().firstSyncDone && afterHttpAbandon.text() === "word") || undefined);
    afterHttpAbandon.close();

    const extraInviteId = randomUUID();
    const extraCreated = await run.createScriptWithCredentials(extraInviteId, state1, secret);
    assert.equal((await run.owner(`scripts/${extraCreated.scriptId}/invitations`, issueRequest("owner", "Desktop 2"), secret)).status, 201);
    assert.deepEqual(await run.createScriptWithCredentials(extraInviteId, state1, secret), { scriptId: extraCreated.scriptId });

    const abandonId = randomUUID();
    const toAbandon = await run.createScriptWithCredentials(abandonId, state1, secret);
    assert.ok(toAbandon.owner && toAbandon.guest);
    assert.equal((await run.owner(`creations/${abandonId}`, { method: "DELETE" }, toAbandon.owner.token)).status, 401);
    assert.equal((await run.owner(`creations/${randomUUID()}`, { method: "DELETE" }, secret)).status, 404);
    assert.equal((await run.owner(`creations/${abandonId}`, { method: "DELETE" }, secret)).status, 204);
    assert.equal((await run.owner(`creations/${abandonId}`, { method: "DELETE" }, secret)).status, 409);
    const abandonedAttempt = kit.copy(port, { kind: "empty" }, toAbandon.scriptId, toAbandon.owner.token);
    const abandonedRefusal = await kit.until(() => abandonedAttempt.events.find(event => event.kind === "authentication-failed"));
    assert.equal(abandonedRefusal.reason, "script-deleted");
    assert.equal((await run.owner(`scripts/${toAbandon.scriptId}/pictures/${"0".repeat(64)}`, {}, toAbandon.guest.token)).status, 403);

    const sharedId = randomUUID();
    const shared = await run.createScriptWithCredentials(sharedId, state1, secret);
    assert.ok(shared.owner && shared.guest);
    const desktop2OwnerReply = await run.owner(`scripts/${shared.scriptId}/invitations`, issueRequest("owner", "Desktop 2"), secret);
    assert.equal(desktop2OwnerReply.status, 201);
    const desktop2Owner = await desktop2OwnerReply.json() as { id: string; token: string; role: InvitationRole };
    kit.redact(desktop2Owner.token);
    const desktop2Conn = kit.copy(port, { kind: "empty" }, shared.scriptId, desktop2Owner.token);
    await kit.until(() => (desktop2Conn.relay.status().firstSyncDone && desktop2Conn.text() === "word") || undefined);
    appendText(desktop2Conn.session, " desktop2", 4);
    await kit.until(() => (desktop2Conn.pending() === 0 && storedText(kit.directory, shared.scriptId) === "word desktop2") || undefined);

    assert.deepEqual(await run.createScriptWithCredentials(sharedId, state1, secret), { scriptId: shared.scriptId });
    assert.equal((await run.owner(`creations/${sharedId}`, { method: "DELETE" }, secret)).status, 409);
    assert.equal(desktop2Conn.relay.status().connected, true);
    assert.equal(storedText(kit.directory, shared.scriptId), "word desktop2");
    const freshCheck = kit.copy(port, { kind: "empty" }, shared.scriptId, desktop2Owner.token);
    await kit.until(() => (freshCheck.relay.status().firstSyncDone && freshCheck.text() === "word desktop2") || undefined);

    const newShare = await run.createScriptWithCredentials(randomUUID(), diffDoc, secret);
    assert.notEqual(newShare.scriptId, shared.scriptId);
    assert.ok(newShare.owner && newShare.guest);

    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    const logs = run.output() + run.errors();
    for (const sensitive of [
      secret, first.owner.token, first.guest.token, retried.owner.token, retried.guest.token,
      toAbandon.owner.token, toAbandon.guest.token, shared.owner.token, shared.guest.token, desktop2Owner.token
    ]) {
      assert.equal(logs.includes(sensitive), false);
    }
  }
);

test("abandon racing a first WebSocket connection or authenticated HTTP request resolves atomically",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const state = kit.seed();
    const secret = randomBytes(32).toString("base64url");
    kit.redact(secret);
    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
    const port = await run.port();

    for (let i = 0; i < 6; i++) {
      const creationId = randomUUID();
      const created = await run.createScriptWithCredentials(creationId, state, secret);
      assert.ok(created.guest);
      const client = kit.copy(port, { kind: "empty" }, created.scriptId, created.guest.token);
      const [abandonReply, wsOutcome] = await Promise.all([
        run.owner(`creations/${creationId}`, { method: "DELETE" }, secret),
        kit.until(() => {
          if (client.relay.status().firstSyncDone) return "synced" as const;
          const failure = client.events.find(event => event.kind === "authentication-failed");
          if (failure) return failure.reason;
          return undefined;
        })
      ]);
      client.close();
      if (abandonReply.status === 204) {
        assert.equal(wsOutcome, "script-deleted");
      } else {
        assert.equal(abandonReply.status, 409);
        assert.equal(wsOutcome, "synced");
      }
    }

    for (let i = 0; i < 6; i++) {
      const creationId = randomUUID();
      const created = await run.createScriptWithCredentials(creationId, state, secret);
      assert.ok(created.guest);
      const [abandonReply, httpReply] = await Promise.all([
        run.owner(`creations/${creationId}`, { method: "DELETE" }, secret),
        run.owner(`scripts/${created.scriptId}/pictures/${"0".repeat(64)}`, {}, created.guest.token)
      ]);
      if (abandonReply.status === 204) {
        assert.equal(httpReply.status, 403);
      } else {
        assert.equal(abandonReply.status, 409);
        assert.equal(httpReply.status, 404);
      }
    }

    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
  }
);
