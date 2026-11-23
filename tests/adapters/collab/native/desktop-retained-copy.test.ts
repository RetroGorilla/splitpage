
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { desktopFixture, replicasAt } from "./desktop-local-store-fixture.ts";
import { seedReplica, STORE_OPTIONS } from "./local-store-fixture.ts";

test("desktop keeps encrypted membership with its scoped replica across a restart and removes both on leave", async t => {
  const { directory } = await desktopFixture(t);
  const key = randomBytes(32);
  const cipher = {
    encrypt(token: string) {
      const iv = randomBytes(12);
      const encryption = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, encryption.update(token, "utf8"), encryption.final(), encryption.getAuthTag()]);
    },
    decrypt(bytes: Buffer) {
      const decryption = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decryption.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decryption.update(bytes.subarray(12, -16)), decryption.final()]).toString("utf8");
    }
  };
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
