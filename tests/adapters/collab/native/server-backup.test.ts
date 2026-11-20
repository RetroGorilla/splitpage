import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { backupRelay, verifyCopy } from "../../../../collab-server/backup.ts";
import { DB_NAME, openWriter } from "../../../../collab-server/storage.ts";
import { appendText, NAME, serverHarness, storedState, storedText } from "./server-harness.ts";
import { seedRelaySession } from "./relay-harness.ts";

const BACKUP = new URL("../../../../collab-server/backup-command.ts", import.meta.url);

test("online backup retains verified bytes for each script and restores without edits made afterward", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const primary = join(kit.directory, "primary");
  const settings = { SPLITPAGE_DATA_DIR: primary };
  const live = kit.launch(settings);
  const port = await live.port();
  const initial = seedRelaySession();
  const seed = initial.encodeState();
  initial.close();
  const writer = kit.copy(port, { kind: "state", state: seed });
  const second = kit.copy(port, { kind: "state", state: seed }, "second-script");
  const peer = kit.copy(port);
  await kit.until(() => peer.text() === "word" || undefined);
  appendText(writer.session, " backed up", 4);
  await kit.until(() => {
    if (live.messages.filter(message => message === "stored").length < 2) return;
    return storedText(primary) === "word backed up" || undefined;
  });

  const paths = join(primary, "backups");
  mkdirSync(paths);
  const sentinel = "keep.txt";
  writeFileSync(join(paths, sentinel), "unrelated");
  for (const day of ["01", "02"]) {
    writeFileSync(join(paths, `relay-2000-01-${day}T00-00-00.000Z-00000000-0000-4000-8000-000000000000.sqlite`), "expired");
  }
  const original = storedState(primary);
  const secondOriginal = storedState(primary, "second-script");
  const backup = kit.launch(settings, BACKUP);
  assert.deepEqual(await backup.exit, { code: 0, exitSignal: null }, backup.errors());
  const name = /Verified relay backup (relay-.*\.sqlite)\./.exec(backup.output())?.[1];
  assert.ok(name);
  assert.deepEqual(readdirSync(paths).sort(), [
    sentinel, "relay-2000-01-02T00-00-00.000Z-00000000-0000-4000-8000-000000000000.sqlite", name
  ]);
  const saved = join(kit.directory, "off-machine.sqlite");
  copyFileSync(join(paths, name), saved);
  const count = live.messages.filter(message => message === "stored").length;
  appendText(writer.session, " then lost", 14);
  await kit.until(() => live.messages.filter(message => message === "stored").length > count || undefined);
  assert.equal(storedText(primary), "word backed up then lost");
  assert.deepEqual(await live.stop("clean"), { code: 0, exitSignal: null });
  writer.close();
  peer.close();
  second.close();

  rmSync(primary, { recursive: true });
  const freshDirectory = join(kit.directory, "restored-data");
  mkdirSync(freshDirectory);
  copyFileSync(saved, join(freshDirectory, DB_NAME));
  assert.deepEqual(storedState(freshDirectory, NAME), original);
  assert.deepEqual(storedState(freshDirectory, "second-script"), secondOriginal);
  const restored = kit.launch({ SPLITPAGE_DATA_DIR: freshDirectory });
  const fresh = kit.copy(await restored.port());
  await kit.until(() => fresh.relay.status().firstSyncDone || undefined);
  assert.equal(fresh.text(), "word backed up");
});

test("backup verification rejects different names, different bytes, and missing or extra scripts", t => {
  const kit = serverHarness(t);
  const copyDirectory = join(kit.directory, "copy");
  using original = openWriter(kit.directory);
  using copy = openWriter(copyDirectory);
  original.exec("INSERT INTO documents VALUES ('one', X'0102')");
  copy.exec("INSERT INTO documents VALUES ('one', X'0102')");
  verifyCopy(original, copy);
  copy.exec("UPDATE documents SET state = X'0103'");
  assert.throws(() => verifyCopy(original, copy), /documents differ/);
  copy.exec("UPDATE documents SET name = 'two', state = X'0102'");
  assert.throws(() => verifyCopy(original, copy), /documents differ/);
  copy.exec("DELETE FROM documents");
  assert.throws(() => verifyCopy(original, copy), /missing documents/);
  copy.exec("INSERT INTO documents VALUES ('one', X'0102'), ('two', X'0102')");
  assert.throws(() => verifyCopy(original, copy), /documents differ/);
  using foreign = new DatabaseSync(":memory:");
  assert.throws(() => verifyCopy(original, foreign), /unrecognized identity or schema/);
});

test("backup of missing storage fails without creating an empty database or publishing a backup", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const failed = kit.launch({}, BACKUP);
  assert.deepEqual(await failed.exit, { code: 1, exitSignal: null });
  assert.match(failed.errors(), /Relay backup failed/);
  assert.deepEqual(readdirSync(kit.directory), []);
});

test("a changed copy fails verification before it can be published or prune a previous backup", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const config = { SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_BACKUP_KEEP: "1" };
  const previous = await backupRelay(config);
  await assert.rejects(backupRelay(config, async (source, path) => {
    const pages = await backup(source, path);
    using db = new DatabaseSync(path);
    db.exec("UPDATE documents SET state = X'00'");
    return pages;
  }), /documents differ/);
  assert.deepEqual(readdirSync(join(kit.directory, "backups")), [previous]);
});
