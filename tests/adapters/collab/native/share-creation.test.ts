import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { createRelayOwner as RelayOwner, createShareCreations as ShareCreations } from "../../../../desktop/relay-owner.ts";
import type { createNativeReplicaFiles as ReplicaFiles } from "../../../../desktop/native-replica-files.ts";
import { createShareAttempt } from "../../../../src/application/collaboration/share.ts";
import { createOperations } from "../../../../src/application/session/operation.ts";
import { enterSharedDocument } from "../../../../src/core/migrate.ts";
import { seedRelaySession } from "./relay-harness.ts";
import { appendText, contentHash, serverHarness, storedText } from "./server-harness.ts";
import { desktopTestCipher, replicasAt } from "./desktop-local-store-fixture.ts";
import { seedReplica, STORE_OPTIONS } from "./local-store-fixture.ts";

const require = createRequire(import.meta.url);
const { createRelayOwner, createShareCreations }: {
  createRelayOwner: typeof RelayOwner; createShareCreations: typeof ShareCreations
} = require("../../../../desktop/relay-owner.ts");
const { createNativeReplicaFiles }: { createNativeReplicaFiles: typeof ReplicaFiles } = require("../../../../desktop/native-replica-files.ts");

function deferred() {
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  return { ready, resolve };
}

async function fixture(t: TestContext) {
  const relay = serverHarness(t);
  const secret = randomBytes(32).toString("base64url");
  const run = relay.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret, SPLITPAGE_DEPLOYMENT_ID: "local" });
  const port = await run.port();
  const address = "http://127.0.0.1:" + port;
  const directory = await mkdtemp(join(tmpdir(), "splitpage-share-creation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keystore = desktopTestCipher(randomBytes(32));
  let offline = false, loseReply = false;
  let responseGate: { received: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const creates: { id: string; hash: string; scriptId: string; owner: string | undefined; guest: string | undefined }[] = [];
  const abandons: { id: string; status: number }[] = [];
  const owner = createRelayOwner(directory, {
    isEncryptionAvailable: () => true, decryptString: keystore.decrypt, encryptString: keystore.encrypt
  }, async (url, init) => {
    if (offline) throw new Error("Offline");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization") === "Bearer " + secret, true);
    const response = await fetch(url, init);
    if (init?.method === "POST" && response.ok) {
      const { scriptId, owner, guest } = await response.clone().json() as {
        scriptId: string; owner?: { token: string }; guest?: { token: string }
      };
      const id = headers.get("Idempotency-Key"), hash = headers.get("Splitpage-Content-SHA256");
      assert.ok(id && hash);
      creates.push({ id, hash, scriptId, owner: owner?.token, guest: guest?.token });
      if (responseGate) {
        responseGate.received.resolve();
        await responseGate.release.ready;
      }
      if (loseReply) {
        await response.body?.cancel();
        throw new Error("Reply lost");
      }
    } else if (init?.method === "DELETE") {
      const id = new URL(String(url)).pathname.split("/").at(-1);
      assert.ok(id);
      abandons.push({ id, status: response.status });
    }
    return response;
  });
  assert.equal(owner.save(address, secret), "saved");
  const files = createNativeReplicaFiles(directory);
  const start = () => createShareCreations(directory, owner, files.remove);
  const main = start();
  const journal = async () => JSON.parse(await readFile(join(directory, "relay-owner-shares.json"), "utf8")) as {
    pending: { creationId: string; contentHash: string; replica?: string }[]; abandon: Record<string, string[]>;
  };
  const replicaStore = () => replicasAt(directory, undefined, keystore).window().store;
  const source = seedRelaySession();
  t.after(() => source.close());
  let epoch = 1, generation = 0, held = false;
  let entered = 0, refuseEntry = false;
  const operations = createOperations({
    session: { epoch: () => epoch, generation: () => generation },
    document: { id: () => source.document().docId },
    destination: { identity: () => directory, generation: () => 0 }
  });
  const workflow = createShareAttempt({
    operations, generation: () => generation, current: () => enterSharedDocument(source.document()),
    hold: () => { held = true; return () => { held = false; }; },
    snapshot: () => source.encodeState(), hash: async bytes => contentHash(bytes),
    newId: randomUUID,
    relay: {
      create: (...args) => main.create("tab", ...args),
      abandon: id => main.abandon("tab", id),
      complete: id => main.complete("tab", id)
    },
    link: created => created.address + "/?join=" + created.scriptId + "#" + created.guest,
    async enter(created, bytes, owns, _release, complete) {
      assert.equal(held && owns() && contentHash(bytes) === creates.at(-1)?.hash, true);
      if (refuseEntry) return false;
      const name = created.deployment + "/" + created.scriptId;
      const copy = await replicaStore().open(name, STORE_OPTIONS);
      assert.equal(copy.kind, "opened");
      assert.ok(copy.membership);
      await copy.membership.join({ token: created.owner, role: "owner", guestLinkToken: created.guest });
      copy.session.close();
      await copy.closed;
      entered++;
      return complete();
    }
  });
  return {
    address, port, relay, creates, abandons, source, main, replicaStore, journal, start, directory,
    scripts: async () => (await run.owner("scripts", {}, secret)).json() as Promise<{ id: string; status: string }[]>,
    share: (signal = new AbortController().signal) => workflow.share(address, signal, () => {}),
    entered: () => entered,
    hold: () => held,
    loseReply(value: boolean) { loseReply = value; },
    offline(value: boolean) { offline = value; },
    refuseEntry(value: boolean) { refuseEntry = value; },
    edit() { appendText(source, "Revised ", 0); generation++; },
    switchDocument() { epoch++; },
    pauseReply() {
      const previous = responseGate = { received: deferred(), release: deferred() };
      return { received: previous.received.ready, release() { responseGate = undefined; previous.release.resolve(); } };
    }
  };
}

test("lost share reply with unchanged content reuses the id and snapshot and keeps fresh owner and guest credentials", async t => {
  const f = await fixture(t);
  f.loseReply(true);
  assert.deepEqual(await f.share(), { kind: "unreachable" });
  f.loseReply(false);
  const shared = await f.share();
  assert.equal(shared.kind, "shared");
  const [first, second] = f.creates;
  assert.ok(first && second);
  assert.equal(first.id === second.id && first.hash === second.hash && first.scriptId === second.scriptId, true);
  assert.equal(first.owner !== second.owner && first.guest !== second.guest, true);
  assert.equal(shared.link.endsWith("#" + second.guest), true);
  assert.ok(second.owner && second.guest);
  assert.deepEqual(await f.journal(), { pending: [], abandon: {} });
  const copy = await f.replicaStore().open("local/" + second.scriptId, STORE_OPTIONS);
  assert.equal(copy.kind, "opened");
  try {
    const membership = await copy.membership?.record();
    assert.equal(membership?.role === "owner" && membership.token === second.owner && membership.guestLinkToken === second.guest, true);
  } finally { copy.session.close(); await copy.closed; }
});

test("an unchanged script can also retry after a refused local handoff", async t => {
  const f = await fixture(t);
  f.refuseEntry(true);
  assert.equal((await f.share()).kind, "failed");
  assert.equal(f.entered(), 0);
  assert.deepEqual(f.abandons, []);
  f.refuseEntry(false);
  assert.equal((await f.share()).kind, "shared");
  const [first, second] = f.creates;
  assert.ok(first && second);
  assert.equal(first.id === second.id && first.hash === second.hash && first.scriptId === second.scriptId, true);
  assert.equal(first.owner !== second.owner && first.guest !== second.guest, true);
});

for (const touched of [false, true]) test("lost reply then edit shares revised bytes with prior creation touched=" + touched, async t => {
  const f = await fixture(t);
  f.loseReply(true);
  assert.equal((await f.share()).kind, "unreachable");
  const first = f.creates[0];
  assert.ok(first);
  if (touched) {
    const visitor = f.relay.copy(f.port, undefined, first.scriptId, first.guest);
    await f.relay.until(() => visitor.relay.status().firstSyncDone ? true : undefined);
    visitor.close();
  }
  f.edit();
  f.loseReply(false);
  assert.equal((await f.share()).kind, "shared");
  const second = f.creates[1];
  assert.ok(second);
  assert.equal(first.id !== second.id && first.hash !== second.hash && first.scriptId !== second.scriptId, true);
  assert.deepEqual(f.abandons, [{ id: first.id, status: touched ? 409 : 204 }]);
  assert.match(storedText(f.relay.directory, second.scriptId) ?? "", /^Revised /);
  const scripts = await f.scripts();
  assert.equal(scripts.find(item => item.id === first.scriptId)?.status, touched ? "active" : "deleted");
});

for (const operation of ["edit", "switch", "cancel"] as const) test("share upload attaches to nothing after " + operation, async t => {
  const f = await fixture(t);
  const gate = f.pauseReply();
  const cancel = new AbortController();
  const sharing = f.share(cancel.signal);
  try {
    await gate.received;
    assert.equal(f.hold(), true);
    if (operation === "edit") f.edit();
    if (operation === "switch") f.switchDocument();
    if (operation === "cancel") cancel.abort();
  } finally { gate.release(); }
  assert.equal((await sharing).kind, operation === "cancel" ? "cancelled" : "document-changed");
  assert.equal(f.entered(), 0);
  assert.equal(f.hold(), false);
  assert.deepEqual(f.abandons, [{ id: f.creates[0]?.id, status: 204 }]);
  assert.deepEqual(await f.journal(), { pending: [], abandon: {} });
});

for (const offline of [false, true]) test("restart discards uncommitted replica and owner credentials with offline=" + offline, async t => {
  const f = await fixture(t);
  const bytes = f.source.encodeState();
  const original = join(f.directory, "original.splitpage");
  await writeFile(original, JSON.stringify(f.source.document()));
  const before = await readFile(original);
  const id = randomUUID();
  const created = await f.main.create("tab", id, contentHash(bytes), bytes, f.address);
  assert.equal(created.kind, "created");
  const name = created.deployment + "/" + created.scriptId;
  const copy = await f.replicaStore().open(name, STORE_OPTIONS);
  assert.equal(copy.kind, "opened");
  seedReplica(copy.session, { A: "Interrupted share" });
  assert.equal((await copy.flush()).kind, "stored");
  await copy.membership?.join({ token: created.owner, role: "owner", guestLinkToken: created.guest });
  copy.session.close();
  await copy.closed;
  const pending = await f.journal();
  assert.equal(pending.pending[0]?.replica, name);
  const text = JSON.stringify(pending);
  assert.equal(text.includes(created.owner) || text.includes(created.guest), false);

  f.offline(offline);
  const restart = f.start();
  await restart.recover();
  await restart.retryAbandons();
  assert.deepEqual(await readFile(original), before);
  const reopened = await f.replicaStore().open(name, STORE_OPTIONS);
  assert.equal(reopened.kind, "opened");
  try {
    assert.equal(reopened.restored, false);
    assert.equal(await reopened.membership?.record(), null);
  } finally { reopened.session.close(); await reopened.closed; }
  const waiting = await f.journal();
  assert.deepEqual(waiting.pending, []);
  assert.deepEqual(Object.values(waiting.abandon).flat(), offline ? [id] : []);
  if (offline) {
    assert.deepEqual(f.abandons, []);
    f.offline(false);
    await restart.retryAbandons();
  }
  assert.deepEqual(f.abandons, [{ id, status: 204 }]);
  assert.deepEqual(await f.journal(), { pending: [], abandon: {} });
});

test("a restart during an upload abandons the id recorded before sending the request", async t => {
  const f = await fixture(t);
  const gate = f.pauseReply();
  const original = f.source.encodeState();
  const sharing = f.share();
  try {
    await gate.received;
    const pending = await f.journal();
    assert.equal(pending.pending[0]?.contentHash, contentHash(original));
    assert.equal(pending.pending[0]?.replica, undefined);
    const restart = f.start();
    await restart.recover();
    await restart.retryAbandons();
    assert.deepEqual(f.abandons, [{ id: f.creates[0]?.id, status: 204 }]);
    assert.deepEqual(f.source.encodeState(), original);
    f.loseReply(true);
  } finally { gate.release(); }
  assert.equal((await sharing).kind, "unreachable");
  assert.equal(f.entered(), 0);
  assert.deepEqual(await f.journal(), { pending: [], abandon: {} });
});

test("a snapshot over 15 MB is refused before hashing or uploading", async t => {
  const source = seedRelaySession();
  t.after(source.close);
  const operations = createOperations({
    session: { epoch: () => 1, generation: () => 1 },
    document: { id: () => source.document().docId },
    destination: { identity: () => null, generation: () => 0 }
  });
  const never = () => { assert.fail("Over-limit snapshot reached the upload path"); };
  const workflow = createShareAttempt({
    operations, generation: () => 1, current: () => enterSharedDocument(source.document()), hold: () => () => {},
    snapshot: () => new Uint8Array(15_000_001), hash: never, newId: never,
    relay: { create: never, abandon: never, complete: never }, enter: never, link: never
  });
  assert.deepEqual(await workflow.share("https://relay.example", new AbortController().signal, never), { kind: "too-large" });
});
