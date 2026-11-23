import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs, { cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backupRelay, lastBackupTime, restoreRelay, verifyCopy } from "../../../../collab-server/backup.ts";
import { DB_NAME, openWriter } from "../../../../collab-server/storage.ts";
import { appendText, NAME, serverHarness, storedState, storedText } from "./server-harness.ts";
import { seedRelaySession } from "./relay-harness.ts";

const BACKUP = new URL("../../../../collab-server/backup-command.ts", import.meta.url);
const RESTORE = fileURLToPath(new URL("../../../../collab-server/restore-command.ts", import.meta.url));

test("an interrupted backup releases ownership without risking the only retained bundle", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const directory = kit.directory;
  const backups = join(directory, "backups");
  const settings = { SPLITPAGE_DATA_DIR: directory, SPLITPAGE_BACKUP_KEEP: "1" };
  const syncDirectory = process.platform === "win32" ? () => {} : undefined;
  const prior = await backupRelay(settings, backup, syncDirectory);
  const moduleUrl = new URL("../../../../collab-server/backup.ts", import.meta.url);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { backup } from "node:sqlite";
    import { backupRelay } from ${JSON.stringify(moduleUrl.href)};
    const syncDirectory = process.platform === "win32" ? () => {} : undefined;
    await backupRelay(process.env, async (source, pending) => {
      await backup(source, pending);
      setInterval(() => {}, 1000);
      process.stdout.write("staged");
      await new Promise(() => {});
    }, syncDirectory);
  `], { env: settings, stdio: ["ignore", "pipe", "ignore"] });
  const exit = once(child, "exit");
  try {
    const checkpoint = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => String(chunk)), exit.then(() => "child exited")
    ]);
    assert.equal(checkpoint, "staged");
    const contender = kit.launch(settings, BACKUP);
    assert.deepEqual(await contender.exit, { code: 1, exitSignal: null });
    assert.match(contender.errors(), /A relay backup is already running/);
    assert.equal(contender.output(), "");
    assert.deepEqual(readdirSync(backups).filter(name => name.endsWith(".backup")), [prior]);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
  const beforeRetry = join(directory, "before-retry");
  await restoreRelay(join(backups, prior), beforeRetry);
  assert.equal(storedText(beforeRetry), "word");
  const replacement = await backupRelay(settings, backup, syncDirectory);
  assert.deepEqual(readdirSync(backups), [replacement]);
  const restored = join(directory, "after-retry");
  await restoreRelay(join(backups, replacement), restored);
  assert.equal(storedText(restored), "word");
});

test("backup without directory sync refuses full retention before copying and accepts manual rotation", async t => {
  const kit = serverHarness(t);
  kit.seed();
  const settings = { SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_BACKUP_KEEP: "1" };
  const backups = join(kit.directory, "backups");
  const syncDirectory = process.platform === "win32" ? undefined : null;
  const prior = await backupRelay(settings, backup, syncDirectory);
  let copied = false;
  await assert.rejects(backupRelay(settings, async () => {
    copied = true;
    return 0;
  }, syncDirectory), /retention is full.*Verify an off-machine copy.*then retry/);
  assert.equal(copied, false);
  assert.deepEqual(readdirSync(backups), [prior]);
  const rotated = join(kit.directory, "rotated.backup");
  renameSync(join(backups, prior), rotated);
  const replacement = await backupRelay(settings, backup, syncDirectory);
  assert.deepEqual(readdirSync(backups), [replacement]);
  const restored = join(kit.directory, "rotated-restore");
  await restoreRelay(rotated, restored);
  assert.equal(storedText(restored), "word");
});

test("interrupted restore keeps its target absent and concurrent restores publish only once", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const archive = join(kit.directory, "backups", await backupRelay({ SPLITPAGE_DATA_DIR: kit.directory }));
  const target = join(kit.directory, "recovered");
  const empty = join(kit.directory, "empty");
  mkdirSync(empty);
  await assert.rejects(restoreRelay(archive, empty), /requires a new data directory/);
  assert.deepEqual(readdirSync(empty), []);
  const claimed = join(kit.directory, "claimed");
  await assert.rejects(restoreRelay(archive, claimed, async (source, pending) => {
    const pages = await backup(source, pending);
    mkdirSync(claimed);
    return pages;
  }), /requires a new data directory/);
  assert.deepEqual(readdirSync(claimed), []);

  const moduleUrl = new URL("../../../../collab-server/backup.ts", import.meta.url);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { backup } from "node:sqlite";
    import { restoreRelay } from ${JSON.stringify(moduleUrl.href)};
    await restoreRelay(process.argv[1], process.argv[2], async (source, pending) => {
      await backup(source, pending);
      setInterval(() => {}, 1000);
      process.stdout.write("staged");
      await new Promise(() => {});
    });
  `, archive, target], { env: {}, stdio: ["ignore", "pipe", "ignore"] });
  const exit = once(child, "exit");
  try {
    const checkpoint = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => String(chunk)), exit.then(() => "child exited")
    ]);
    assert.equal(checkpoint, "staged");
    assert.equal(existsSync(target), false);
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
  assert.equal(existsSync(target), false);

  const results = await Promise.allSettled([restoreRelay(archive, target), restoreRelay(archive, target)]);
  assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(storedText(target), "word");
});

test("online backup retains verified bytes for each script and restores without edits made afterward", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  const primary = join(kit.directory, "primary");
  const settings = { SPLITPAGE_DATA_DIR: primary };
  kit.provision("second-script", primary);
  const live = kit.launch(settings);
  const port = await live.port();
  const initial = seedRelaySession();
  const seed = initial.encodeState();
  initial.close();
  const creationId = randomUUID();
  const deletedScript = await live.createScript(randomUUID(), seed);
  assert.equal((await live.owner(`scripts/${deletedScript}`, { method: "DELETE" })).status, 204);
  const createdScript = await live.createScript(creationId, seed);
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
  const backup = kit.launch({ ...settings, SPLITPAGE_BACKUP_KEEP: process.platform === "win32" ? "3" : "2" }, BACKUP);
  assert.deepEqual(await backup.exit, { code: 0, exitSignal: null }, backup.errors());
  const name = /Verified relay backup (relay-.*\.backup)\./.exec(backup.output())?.[1];
  assert.ok(name);
  assert.deepEqual(readdirSync(paths).sort(), [
    sentinel,
    ...(process.platform === "win32" ? ["relay-2000-01-01T00-00-00.000Z-00000000-0000-4000-8000-000000000000.sqlite"] : []),
    "relay-2000-01-02T00-00-00.000Z-00000000-0000-4000-8000-000000000000.sqlite", name
  ]);
  const saved = join(kit.directory, "off-machine.backup");
  cpSync(join(paths, name), saved, { recursive: true });
  const count = live.messages.filter(message => message === "stored").length;
  appendText(writer.session, " then lost", 14);
  await kit.until(() => live.messages.filter(message => message === "stored").length > count || undefined);
  assert.equal(storedText(primary), "word backed up then lost");
  assert.deepEqual(await live.stop("clean"), { code: 0, exitSignal: null });
  writer.close();
  peer.close();
  second.close();

  const freshDirectory = join(kit.directory, "restored-data");
  await assert.rejects(restoreRelay(saved, primary), /requires a new data directory/);
  const restore = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", RESTORE, saved, freshDirectory], {
    env: {}, encoding: "utf8"
  });
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(restore.stderr, "");
  assert.equal(restore.stdout.trim(), "Verified relay restore. All invitations are revoked.");
  {
    using archive = new DatabaseSync(join(saved, DB_NAME), { readOnly: true });
    assert.ok(archive.prepare("SELECT 1 FROM invitations WHERE revoked = 0").get());
  }
  assert.deepEqual(storedState(freshDirectory, NAME), original);
  assert.deepEqual(storedState(freshDirectory, "second-script"), secondOriginal);
  const restored = kit.launch({ SPLITPAGE_DATA_DIR: freshDirectory });
  const retry = await restored.owner("scripts", {
    method: "POST", headers: { "Idempotency-Key": creationId }
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { scriptId: createdScript });
  assert.deepEqual(storedState(freshDirectory, createdScript), seed);
  const portAfterRestore = await restored.port();
  const previous = kit.copy(portAfterRestore);
  const refusal = await kit.until(() => previous.events.find(event => event.kind === "authentication-failed"));
  assert.equal(refusal.reason, "invitation-revoked");
  const issue = { method: "POST", body: "Restore drill" };
  assert.equal((await restored.owner(`scripts/${deletedScript}/invitations`, issue)).status, 409);
  const issued = await restored.owner(`scripts/${NAME}/invitations`, issue);
  assert.equal(issued.status, 201);
  const { token } = await issued.json() as { token: string };
  const fresh = kit.copy(portAfterRestore, { kind: "empty" }, NAME, token);
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

test("backup verification rejects changed or missing access records without exposing their values", async t => {
  const kit = serverHarness(t);
  const { id } = kit.provision(NAME);
  kit.provision("second-script");
  using source = openWriter(kit.directory);
  source.prepare("INSERT INTO creations VALUES (?, ?)").run(randomUUID(), NAME);
  const copyDirectory = join(kit.directory, "copy");
  mkdirSync(copyDirectory);
  const path = join(copyDirectory, DB_NAME);
  await backup(source, path);
  using copy = openWriter(copyDirectory);
  verifyCopy(source, copy);

  for (const [sql, args, message] of [
    ["UPDATE scripts SET status = 'deleted' WHERE name = ?", [NAME], "scripts differ"],
    ["INSERT INTO scripts VALUES (?, 'pending')", ["extra-script"], "scripts differ"],
    ["UPDATE invitations SET revoked = 1 WHERE id = ?", [id], "invitations differ"],
    ["UPDATE invitations SET label = 'different' WHERE id = ?", [id], "invitations differ"],
    ["UPDATE invitations SET script = 'second-script' WHERE id = ?", [id], "invitations differ"],
    ["UPDATE invitations SET token_hash = randomblob(32) WHERE id = ?", [id], "invitations differ"],
    ["UPDATE creations SET script = 'second-script'", [], "creations differ"],
    ["DELETE FROM creations", [], "is missing creations"],
    ["DELETE FROM invitations", [], "is missing invitations"]
  ] as const) {
    copy.exec("BEGIN");
    try {
      copy.prepare(sql).run(...args);
      assert.throws(() => verifyCopy(source, copy), { message: `Relay backup ${message} from the source snapshot.` });
    } finally {
      copy.exec("ROLLBACK");
    }
  }
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
  const previous = await backupRelay(config, backup, () => {});
  await assert.rejects(backupRelay(config, async (source, path) => {
    const pages = await backup(source, path);
    using db = new DatabaseSync(path);
    db.exec("UPDATE documents SET state = X'00'");
    return pages;
  }, () => {}), /documents differ/);
  assert.deepEqual(readdirSync(join(kit.directory, "backups")), [previous]);
});

test("retention always keeps the just-verified backup and ignores backup-shaped directories", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.seed();
  const config = { SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_BACKUP_KEEP: "1" };
  const first = await backupRelay(config);
  const directory = join(kit.directory, "backups");
  const future = first.replace(/relay-\d{4}/, "relay-2099");
  const unrelated = first.replace(/relay-\d{4}/, "relay-2098");
  renameSync(join(directory, first), join(directory, future));
  mkdirSync(join(directory, unrelated));
  kit.seed("new-script");
  const justMade = await backupRelay(config, backup, () => {});
  assert.deepEqual(readdirSync(directory).sort(), [justMade, unrelated].sort());
  using copy = new DatabaseSync(join(directory, justMade, DB_NAME), { readOnly: true });
  assert.equal(copy.prepare("SELECT count(*) AS count FROM documents").get()?.count, 2);
});

test("backup preflight rejects a foreign source before asking SQLite to copy", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  {
    using db = openWriter(kit.directory);
    db.exec("PRAGMA application_id=0");
  }
  let attempted = false;
  await assert.rejects(backupRelay({ SPLITPAGE_DATA_DIR: kit.directory }, async () => {
    attempted = true;
    return 0;
  }), /unrecognized identity or schema/);
  assert.equal(attempted, false);
  assert.equal(readdirSync(kit.directory).includes("backups"), false);
});

test("online backup copies the preflight snapshot even when a second connection commits before copying", { timeout: 30_000 }, async t => {
  const kit = serverHarness(t);
  kit.provision("one");
  using writer = openWriter(kit.directory);
  writer.exec("INSERT INTO documents VALUES ('one', X'01'), ('two', X'02')");
  const name = await backupRelay({ SPLITPAGE_DATA_DIR: kit.directory }, async (source, path) => {
    writer.exec("BEGIN; UPDATE documents SET state = X'03'; UPDATE scripts SET status = 'deleted'; UPDATE invitations SET revoked = 1; COMMIT");
    return backup(source, path);
  });
  assert.deepEqual(writer.prepare("SELECT hex(state) AS state FROM documents ORDER BY name").all().map(row => row.state), ["03", "03"]);
  assert.equal(writer.prepare("SELECT status FROM scripts").get()?.status, "deleted");
  assert.equal(writer.prepare("SELECT revoked FROM invitations").get()?.revoked, 1);
  using copy = new DatabaseSync(join(kit.directory, "backups", name, DB_NAME), { readOnly: true });
  assert.deepEqual(copy.prepare("SELECT hex(state) AS state FROM documents ORDER BY name").all().map(row => row.state), ["01", "02"]);
  assert.equal(copy.prepare("SELECT status FROM scripts").get()?.status, "active");
  assert.equal(copy.prepare("SELECT revoked FROM invitations").get()?.revoked, 0);
});


test("backup publishes marker only after durable bundle sync, fails safely on marker write errors and ignores malformed markers",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    kit.seed();
    const config = { SPLITPAGE_DATA_DIR: kit.directory, SPLITPAGE_BACKUP_KEEP: "1" };
    const backupsDir = join(kit.directory, "backups");
    const markerPath = join(kit.directory, "last-backup.json");
    const events: string[] = [];
    let failBundleSync = true;
    let failMarkerWrite = false;
    const originalOpen = fs.openSync;
    const originalRename = fs.renameSync;
    const openMock = t.mock.method(fs, "openSync", (path: fs.PathLike, flags: fs.OpenMode = "r", mode?: fs.Mode) => {
      const text = String(path);
      if (failMarkerWrite && text.includes(".last-backup-")) {
        throw Object.assign(new Error("simulated marker write failure"), { code: "EIO" });
      }
      return originalOpen(path, flags, mode);
    });
    const renameMock = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === markerPath) events.push("marker-rename");
      originalRename(from, to);
    });
    syncBuiltinESMExports();
    const syncSpy = (path: string) => {
      events.push(`sync:${path}`);
      if (failBundleSync && path === backupsDir) {
        throw Object.assign(new Error("simulated bundle sync failure"), { code: "EIO" });
      }
    };
    try {
      await assert.rejects(backupRelay(config, backup, syncSpy), { code: "EIO" });
      assert.equal(lastBackupTime(kit.directory), null);

      failBundleSync = false;
      events.length = 0;
      const first = await backupRelay(config, backup, syncSpy);
      const firstTimestamp = lastBackupTime(kit.directory);
      assert.ok(firstTimestamp !== null);
      const backupsSyncIndex = events.indexOf(`sync:${backupsDir}`);
      const markerRenameIndex = events.indexOf("marker-rename");
      const parentSyncAfterMarker = events.lastIndexOf(`sync:${kit.directory}`);
      assert.ok(backupsSyncIndex >= 0);
      assert.ok(markerRenameIndex > backupsSyncIndex);
      assert.ok(parentSyncAfterMarker > markerRenameIndex);

      failMarkerWrite = true;
      await assert.rejects(backupRelay(config, backup, syncSpy), { code: "EIO" });
      assert.equal(lastBackupTime(kit.directory), firstTimestamp);
      assert.ok(readdirSync(backupsDir).includes(first));
      assert.equal(readdirSync(kit.directory).some(name => name.startsWith(".last-backup-")), false);
    } finally {
      openMock.mock.restore();
      renameMock.mock.restore();
      syncBuiltinESMExports();
    }

    writeFileSync(markerPath, "{malformed");
    assert.equal(lastBackupTime(kit.directory), null);
  }
);
