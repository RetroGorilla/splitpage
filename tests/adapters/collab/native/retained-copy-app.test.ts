
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { bootApp, closeApp } from "../../../../src/test/_app-boot.mjs";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import { adoptReplacement, currentDocument } from "../../../../src/bootstrap/wiring/session-owner.ts";
import { enterRetainedSharedScript, leaveRetainedSharedScript } from "../../../../src/bootstrap/wiring/retained-shared-script.ts";
import { leaveRunningSharedSession } from "../../../../src/bootstrap/wiring/shared-session.ts";
import { nativeEntrySwitchFixture } from "../../../bootstrap/native-entry-switch-support.ts";
import { DB_NAME, seedSession, storedEntries } from "./local-store-fixture.ts";
import { idbResult } from "./indexeddb-fixture.ts";

test("the app opens a retained shared script offline and Leave closes its connection and clears device state", async t => {
  await bootApp();
  t.after(closeApp);
  adoptReplacement(migrateRows({ schema: 2, title: "Standby", rows: [] }));
  const source = seedSession({ A: "Retained narration" });
  const state = source.encodeState();
  source.close();
  const identity = { deployment: "local-fixture", script: "first-script" };
  const name = identity.deployment + "/" + identity.script;
  const invitation = { token: randomBytes(32).toString("base64url"), state };
  const { ports } = nativeEntrySwitchFixture();
  assert.deepEqual(await enterRetainedSharedScript(ports, { ...identity, invitation }), { ok: true });
  assert.match(currentDocument()?.rows[0]?.audioText ?? "", /Retained narration/);
  assert.deepEqual(leaveRunningSharedSession(false), { ok: true });
  const connectionsClosed = t.mock.fn();
  assert.deepEqual(await enterRetainedSharedScript(ports, {
    ...identity,
    connect: (_, token) => {
      assert.equal(token === invitation.token, true);
      return connectionsClosed;
    }
  }), { ok: true });
  assert.match(currentDocument()?.rows[0]?.audioText ?? "", /Retained narration/);
  assert.deepEqual(await leaveRetainedSharedScript(), { ok: true });
  assert.equal(connectionsClosed.mock.callCount(), 1);
  const factory = window.indexedDB;
  assert.deepEqual(await storedEntries(factory, name), []);
  const database = await idbResult(factory.open(DB_NAME));
  try {
    for (const store of ["memberships", "invitations"]) {
      assert.equal((await idbResult(database.transaction(store).objectStore(store).get(name))) === undefined, true);
    }
  } finally { database.close(); }
  assert.equal((await enterRetainedSharedScript(ports, identity)).ok, false);
});
