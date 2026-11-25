
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { createNativeReplicaFiles as CreateFiles } from "../../../../desktop/native-replica-files.ts";
import { readNativeMembership } from "../../../../shared/native-membership.ts";
import { desktopFixture, desktopTestCipher, replicaFileFaults, replicasAt } from "./desktop-local-store-fixture.ts";
import { seedReplica, STORE_OPTIONS } from "./local-store-fixture.ts";

const { createNativeReplicaFiles }: { createNativeReplicaFiles: typeof CreateFiles } =
  createRequire(import.meta.url)("../../../../desktop/native-replica-files.ts");

test("a guest record ignores stale owner password settings and retains both credentials", () => {
  const record = { token: "device-token", guestLinkToken: "link-token", role: "guest" };
  assert.deepEqual(readNativeMembership({ ...record, linkPasswordRequired: true }), record);
  assert.deepEqual(readNativeMembership({ ...record, linkPasswordRequired: "true" }), record);
});

test("the desktop store opens an old encrypted single-token record as a guest", async t => {
  const { directory, store } = await desktopFixture(t);
  const cipher = desktopTestCipher(randomBytes(32));
  const name = "deployment/legacy";
  const token = randomBytes(32).toString("base64url");
  const fixture = await store.open(name, STORE_OPTIONS);
  assert.equal(fixture.kind, "opened");
  seedReplica(fixture.session, { A: "Existing shared copy" });
  assert.equal((await fixture.flush()).kind, "stored");
  fixture.session.close();
  await fixture.closed;
  const files = await createNativeReplicaFiles(directory).open(name);
  await files.writeMembership(cipher.encrypt(token));
  const copy = await replicasAt(directory, undefined, cipher).window().store.open(name, STORE_OPTIONS);
  assert.equal(copy.kind, "opened");
  try {
    assert.equal(copy.restored, true);
    assert.equal(copy.session.document().rows[0]?.audioText, "Existing shared copy");
    assert.deepEqual(await copy.membership?.record(), { token, role: "guest" });
  } finally { copy.session.close(); await copy.closed; }
});

test("desktop keeps encrypted membership with its scoped replica across a restart and removes both on leave", async t => {
  const { directory } = await desktopFixture(t);
  const key = randomBytes(32);
  const cipher = desktopTestCipher(key);
  const main = replicasAt(directory, undefined, cipher);
  const first = main.window().store, second = main.window().store;
  const name = "deployment/script";
  const otherName = "deployment/replacement";
  const invitation = randomBytes(32).toString("base64url");
  const replica = await first.open(name, STORE_OPTIONS);
  const replacement = await second.open(otherName, STORE_OPTIONS);
  assert.equal(replica.kind, "opened");
  assert.equal(replacement.kind, "opened");
  assert.ok(replica.membership && replacement.membership);
  assert.deepEqual(await second.open(name, STORE_OPTIONS), { kind: "failed", reason: "locked" });
  assert.equal(await replacement.membership.token(), null);
  await replica.membership.join(invitation);
  assert.equal((await replica.membership.token()) === invitation, true);
  seedReplica(replica.session, { A: "Offline first script" });
  seedReplica(replacement.session, { A: "Replacement script" });
  const firstState = replica.session.encodeState(), replacementState = replacement.session.encodeState();
  assert.equal((await replica.flush()).kind, "stored");
  assert.equal((await replacement.flush()).kind, "stored");
  replica.session.close();
  replacement.session.close();
  await Promise.all([replica.closed, replacement.closed]);
  const file = join(directory, "native-replicas", createHash("sha256").update(name).digest("hex"), "membership");
  assert.equal((await readFile(file)).includes(invitation), false);

  const restarted = replicasAt(directory, undefined, cipher).window().store;
  const offline = await restarted.open(name, STORE_OPTIONS);
  assert.equal(offline.kind, "opened");
  assert.equal((await offline.membership?.token()) === invitation, true);
  assert.deepEqual(offline.session.encodeState(), firstState);
  const removed = offline.discardOnClose?.();
  offline.session.close();
  assert.equal(await removed, true);
  assert.equal((await readdir(join(directory, "native-replicas"))).length, 1);
  const kept = await restarted.open(otherName, STORE_OPTIONS);
  assert.equal(kept.kind, "opened");
  assert.deepEqual(kept.session.encodeState(), replacementState);
  kept.session.close();
  await kept.closed;
});

test("interrupted desktop membership replacement and erase preserve the previous copy", async t => {
  const { directory } = await desktopFixture(t);
  const disk = replicaFileFaults();
  const cipher = desktopTestCipher(randomBytes(32));
  const name = "deployment/interrupted-script";
  const original = randomBytes(32).toString("base64url");
  const store = replicasAt(directory, disk.fileSystem, cipher).window().store;
  const first = await store.open(name, STORE_OPTIONS);
  assert.equal(first.kind, "opened");
  assert.ok(first.membership);
  await first.membership.join(original);
  seedReplica(first.session, { A: "Kept copy" });
  assert.equal((await first.flush()).kind, "stored");
  const state = first.session.encodeState();
  disk.intercept("membership.new:rename", async () => { throw new Error("interrupted"); });
  await assert.rejects(first.membership.join(randomBytes(32).toString("base64url")), /Could not save shared membership/);
  const hash = createHash("sha256").update(name).digest("hex");
  disk.intercept(hash + ":rename", async () => { throw new Error("interrupted"); });
  const discarded = first.discardOnClose?.();
  first.session.close();
  assert.equal(await discarded, false);
  const restarted = replicasAt(directory, undefined, cipher).window().store;
  const copy = await restarted.open(name, STORE_OPTIONS);
  assert.equal(copy.kind, "opened");
  try {
    assert.equal((await copy.membership?.token()) === original, true);
    assert.deepEqual(copy.session.encodeState(), state);
  } finally { copy.session.close(); await copy.closed; }
});
