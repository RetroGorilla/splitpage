import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { backupRelay } from "../../../../collab-server/backup.ts";
import { DB_NAME, openWriter, verifyDatabase } from "../../../../collab-server/storage.ts";
import { appendText, serverHarness, storedState, storedText } from "./server-harness.ts";

interface ExpectedInvitationEntry {
  readonly id: string;
  readonly label: string;
  readonly state: "active" | "revoked";
}

interface ExpectedStatusValues {
  readonly pictureBytes: number;
  readonly uploadsInFlight: number;
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
    hasExactKeys(parsed, ["connections", "uploadsInFlight", "storedBytes", "pictureBytes", "lastStorageFailure", "lastBackupAt"]) &&
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
        hasExactKeys(entry, ["id", "label", "state"]) &&
        entry.id === target.id &&
        entry.label === target.label &&
        entry.state === target.state;
    });
  assert.equal(valid, true, "invitation-list response must match expected invitation entries");
}

function readScriptIdPayload(raw: string, sensitiveValues: readonly string[], expectedScriptId?: string): string {
  const parsed = parseSafeJson(raw, sensitiveValues, "script response");
  const record = isPlainObject(parsed) ? parsed : null;
  const scriptId = record?.scriptId;
  const valid = record !== null &&
    hasExactKeys(record, ["scriptId"]) &&
    typeof scriptId === "string" &&
    /^[a-f0-9-]{36}$/.test(scriptId) &&
    (expectedScriptId === undefined || scriptId === expectedScriptId);
  assert.equal(valid, true, "script response must contain only the expected scriptId");
  return scriptId as string;
}

function readIssuedInvitationPayload(raw: string, sensitiveValues: readonly string[]): { id: string; token: string } {
  const parsed = parseSafeJson(raw, sensitiveValues, "issued invitation response");
  const record = isPlainObject(parsed) ? parsed : null;
  const id = record?.id;
  const token = record?.token;
  const valid = record !== null &&
    hasExactKeys(record, ["id", "token"]) &&
    typeof id === "string" &&
    id.length > 0 &&
    typeof token === "string" &&
    /^[a-zA-Z0-9_-]{43}$/.test(token);
  assert.equal(valid, true, "issued invitation response must contain only a valid id and token");
  return { id: id as string, token: token as string };
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
  {
    using db = openWriter(kit.directory);
    db.prepare("INSERT INTO scripts VALUES (?, 'pending')").run("pending-script");
  }
  const secret = randomBytes(32).toString("base64url");
  const wrong = randomBytes(32).toString("base64url");
  const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
  const create = { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: Buffer.from(state) };
  assert.equal((await run.owner("scripts", create, null)).status, 401);
  assert.equal((await run.owner("scripts", create, wrong)).status, 401);
  assert.equal((await run.owner("scripts", { ...create, body: null }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { ...create, body: Uint8Array.of(255) }, secret)).status, 400);
  assert.equal((await run.owner("scripts", { ...create, body: Buffer.alloc(15_000_001) }, secret)).status, 413);
  const id = create.headers["Idempotency-Key"];
  const [script, retry] = await Promise.all([run.createScript(id, state, secret), run.createScript(id, state, secret)]);
  assert.equal(script, retry);
  assert.deepEqual(storedState(kit.directory, script), state);
  const ownerPort = await run.port();
  const expectRetries = async () => {
    for (const body of [null, Uint8Array.of(255)]) {
      const response = await run.owner("scripts", { ...create, body }, secret);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { scriptId: script });
    }
    const oversized = await new Promise<{ status: number | undefined; connection: string | undefined; body: string }>((resolve, reject) => {
      const upload = request({
        hostname: "127.0.0.1", port: ownerPort, path: "/api/scripts", method: "POST",
        headers: { ...create.headers, Authorization: `Bearer ${secret}`, "Content-Length": "15000001" },
        signal: t.signal
      }, async response => {
        try {
          let body = "";
          response.setEncoding("utf8");
          for await (const chunk of response) body += chunk;
          resolve({ status: response.statusCode, connection: response.headers.connection, body });
        } catch (error) {
          reject(error);
        }
      });
      upload.on("error", reject);
      upload.flushHeaders();
    });
    assert.deepEqual(oversized, { status: 200, connection: "close", body: JSON.stringify({ scriptId: script }) });
  };
  await expectRetries();
  assert.deepEqual(storedState(kit.directory, script), state);

  const path = `scripts/${script}/invitations`;
  const issue = { method: "POST", body: "Reader" };
  const remove = { method: "DELETE" };
  assert.equal((await run.owner("scripts/pending-script/invitations", issue, secret)).status, 409);
  const issued = await run.owner(path, issue, secret);
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const invitation = await issued.json() as { id: string; token: string };
  assert.ok(/^[a-zA-Z0-9_-]{43}$/.test(invitation.token));
  const fresh = kit.copy(await run.port(), { kind: "empty" }, script, invitation.token);
  t.after(fresh.session.close);
  await kit.until(() => fresh.relay.status().firstSyncDone && fresh.text() === "word" || undefined);
  const list = async (state: string) => {
    const reply = await run.owner(path, {}, secret);
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), [{ id: invitation.id, label: "Reader", state }]);
  };
  await list("active");
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
  await list("revoked");
  assert.equal((await run.owner(picturePath, {}, invitation.token)).status, 403);
  assert.equal((await run.owner(`scripts/${script}`, remove, secret)).status, 204);
  assert.equal((await run.owner(path, issue, secret)).status, 409);
  await expectRetries();
  await run.stop("clean");
  const restarted = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
  assert.equal(await restarted.createScript(id, state, secret), script);
  assert.equal((await restarted.owner(path, issue, secret)).status, 409);
  for (const process of [run, restarted]) {
    const logs = process.output() + process.errors();
    assert.ok(![secret, wrong, invitation.token, "Reader"].some(value => logs.includes(value)));
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
  const createdInitial = await initial.owner("scripts", {
    method: "POST", headers: { "Idempotency-Key": creationId }, body: Buffer.from(state)
  }, initialSecret);
  assert.equal(createdInitial.status, 200);
  assert.equal(createdInitial.headers.get("cache-control") === "no-store", true, "script creation response must disable caching");
  const scriptId = readScriptIdPayload(await createdInitial.text(), allSensitiveValues());

  const invitationsPath = `scripts/${scriptId}/invitations`;
  const issuedInitial = await initial.owner(invitationsPath, { method: "POST", body: "Before Rotation" }, initialSecret);
  assert.equal(issuedInitial.status, 201);
  assert.equal(issuedInitial.headers.get("cache-control") === "no-store", true, "initial invitation issue response must disable caching");
  const existingInvite = readIssuedInvitationPayload(await issuedInitial.text(), allSensitiveValues());
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

  const listBefore = await initial.owner(invitationsPath, {}, initialSecret);
  assert.equal(listBefore.status, 200);
  assert.equal(listBefore.headers.get("cache-control") === "no-store", true, "pre-rotation list response must disable caching");
  assertInvitationListPayload(
    await listBefore.text(),
    [{ id: existingInvite.id, label: "Before Rotation", state: "active" }],
    privateNonLabelValues()
  );

  writer.close();
  assert.deepEqual(await initial.stop("clean"), { code: 0, exitSignal: null });
  const stateBeforeRotation = storedState(kit.directory, scriptId);

  const rotated = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: replacementSecret });
  await assertStatusNoLeak(await rotated.owner("status", {}, null), 401, "post-rotation status without credential");
  await assertStatusNoLeak(await rotated.owner(invitationsPath, {}, null), 401, "post-rotation list without credential");
  await assertStatusNoLeak(await rotated.owner("status", {}, initialSecret), 401, "post-rotation status with retired secret");
  await assertStatusNoLeak(await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": creationId } }, initialSecret), 401, "post-rotation retry with retired secret");
  await assertStatusNoLeak(await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: Buffer.from(state) }, initialSecret), 401, "post-rotation create with retired secret");
  await assertStatusNoLeak(await rotated.owner(invitationsPath, {}, initialSecret), 401, "post-rotation list with retired secret");
  await assertStatusNoLeak(await rotated.owner(invitationsPath, { method: "POST", body: "Retired Attempt" }, initialSecret), 401, "post-rotation issue with retired secret");
  await assertStatusNoLeak(await rotated.owner(`invitations/${existingInvite.id}`, { method: "DELETE" }, initialSecret), 401, "post-rotation revoke with retired secret");
  await assertStatusNoLeak(await rotated.owner(`scripts/${scriptId}`, { method: "DELETE" }, initialSecret), 401, "post-rotation delete with retired secret");

  const statusAfter = await rotated.owner("status", {}, replacementSecret);
  assert.equal(statusAfter.status, 200);
  assert.equal(statusAfter.headers.get("cache-control") === "no-store", true, "post-rotation status response must disable caching");
  assertStatusPayload(await statusAfter.text(), { pictureBytes: picture.length, uploadsInFlight: 0 }, allSensitiveValues());

  const listAfter = await rotated.owner(invitationsPath, {}, replacementSecret);
  assert.equal(listAfter.status, 200);
  assert.equal(listAfter.headers.get("cache-control") === "no-store", true, "post-rotation list response must disable caching");
  assertInvitationListPayload(
    await listAfter.text(),
    [{ id: existingInvite.id, label: "Before Rotation", state: "active" }],
    privateNonLabelValues()
  );

  const retryAfter = await rotated.owner("scripts", { method: "POST", headers: { "Idempotency-Key": creationId } }, replacementSecret);
  assert.equal(retryAfter.status, 200);
  assert.equal(retryAfter.headers.get("cache-control") === "no-store", true, "post-rotation retry response must disable caching");
  readScriptIdPayload(await retryAfter.text(), allSensitiveValues(), scriptId);
  assert.equal(Buffer.from(storedState(kit.directory, scriptId)).equals(stateBeforeRotation), true, "stored script bytes must survive rotation unchanged");

  const issuedAfter = await rotated.owner(invitationsPath, { method: "POST", body: "After Rotation" }, replacementSecret);
  assert.equal(issuedAfter.status, 201);
  assert.equal(issuedAfter.headers.get("cache-control") === "no-store", true, "post-rotation issue response must disable caching");
  const postInvite = readIssuedInvitationPayload(await issuedAfter.text(), allSensitiveValues());
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
    { id: existingInvite.id, label: "Before Rotation", state: "revoked" },
    { id: postInvite.id, label: "After Rotation", state: "active" }
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
    lastBackupAt: null
  };
  const expectedInvite: ExpectedInvitationEntry = { id: "invite-1", label: "Editor", state: "active" };

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
      run: () => readIssuedInvitationPayload(JSON.stringify({ id: "i1", token: "a".repeat(43), secret: sentinel }), [sentinel]),
      expectedMessage: "issued invitation response must not disclose credentials or private values",
      hidden: [sentinel]
    },
    {
      run: () => readIssuedInvitationPayload(`{malformed-${unexpectedField}`, [sentinel]),
      expectedMessage: "issued invitation response must be valid JSON",
      hidden: [sentinel, unexpectedField]
    },
    {
      run: () => readIssuedInvitationPayload(JSON.stringify({ id: "i1", token: "a".repeat(43), extra: unexpectedField }), [sentinel]),
      expectedMessage: "issued invitation response must contain only a valid id and token",
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

for (const version of [1, 2]) {
  test("the relay upgrades populated storage from version " + version, { timeout: 25_000 }, async t => {
    const kit = serverHarness(t);
    const previous = "previous-script";
    const state = kit.seed(previous);
    const { id, token } = kit.provision(previous);
    const creationId = randomUUID();
    let created: string | undefined;
    const path = join(kit.directory, DB_NAME);
    {
      using db = new DatabaseSync(path);
      db.exec("DROP TABLE script_pictures");
      if (version === 1) db.exec("DROP TABLE creations");
      else created = scriptAccess(db).create(creationId, state);
      db.exec("PRAGMA user_version=" + version);
      assert.equal(verifyDatabase(db), version);
    }
    const env = { SPLITPAGE_DATA_DIR: kit.directory };
    const previousBackup = await backupRelay(env);
    const run = kit.launch({}, new URL("./server-process.ts", import.meta.url));
    const response = await run.owner("scripts/previous-script/invitations");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id, label: "test invitation", state: "active" }]);
    assert.deepEqual(storedState(kit.directory, previous), state);
    const peer = kit.copy(await run.port(), { kind: "empty" }, previous, token);
    await kit.until(() => peer.relay.status().firstSyncDone && peer.text() === "word" || undefined);
    const restored = await run.createScript(creationId, state);
    if (created !== undefined) assert.equal(restored, created);
    assert.deepEqual(storedState(kit.directory, restored), state);
    const currentBackup = await backupRelay(env);
    for (const [file, expectedVersion] of [[previousBackup, version], [currentBackup, 3]] as const) {
      using copy = new DatabaseSync(join(kit.directory, "backups", file, DB_NAME), { readOnly: true });
      assert.equal(verifyDatabase(copy), expectedVersion);
      if (expectedVersion >= 2) {
        assert.equal(copy.prepare("SELECT script FROM creations WHERE id = ?").get(creationId)?.script, restored);
      }
    }
    using live = new DatabaseSync(path, { readOnly: true });
    assert.equal(verifyDatabase(live), 3);
    assert.equal(live.prepare("SELECT count(*) AS count FROM script_pictures").get()?.count, 0);
  });
}
