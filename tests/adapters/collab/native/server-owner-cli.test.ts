import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runOwnerCommand } from "../../../../collab-server/owner-command.ts";
import { serverHarness } from "./server-harness.ts";

const CLI = fileURLToPath(new URL("../../../../collab-server/owner-command.ts", import.meta.url));
const REMOTE = "https://relay.example.test";

function bridgeFetch(port: number): typeof globalThis.fetch {
  return (input, init) => {
    const target = input instanceof URL ? input : new URL(String(input));
    assert.equal(target.origin, REMOTE);
    return globalThis.fetch(new URL(target.pathname + target.search, `http://127.0.0.1:${port}`), init);
  };
}

test("owner CLI lists scripts, issues owner and guest invitations, resets guest links, revokes and deletes",
  { timeout: 30_000 }, async t => {
    const kit = serverHarness(t);
    const state = kit.seed();
    const secret = randomBytes(32).toString("base64url");
    kit.redact(secret);
    const run = kit.launch({ SPLITPAGE_MANAGEMENT_SECRET: secret });
    const port = await run.port();
    const created = await run.createScriptWithCredentials(randomUUID(), state, secret);
    assert.ok(created.owner && created.guest);

    const execCli = async (args: readonly string[]) => {
      const lines: string[] = [];
      await runOwnerCommand(args, { SPLITPAGE_MANAGEMENT_SECRET: secret }, {
        fetch: bridgeFetch(port),
        stdout: line => { lines.push(line); }
      });
      return lines.join("\n");
    };

    const scriptsOut = await execCli([REMOTE, "scripts"]);
    const scripts = JSON.parse(scriptsOut) as { id: string; status: string; untouched: boolean }[];
    assert.equal(scripts.some(entry => entry.id === created.scriptId && entry.status === "active" && entry.untouched === true), true);

    const guestLink = await execCli([REMOTE, "issue", created.scriptId, "guest", "Clip Editor"]);
    const parsedGuestUrl = new URL(guestLink);
    assert.equal(parsedGuestUrl.origin, REMOTE);
    assert.equal(parsedGuestUrl.pathname, "/");
    assert.equal(parsedGuestUrl.searchParams.get("join"), created.scriptId);
    const guestToken = parsedGuestUrl.hash.slice(1);
    assert.match(guestToken, /^[a-zA-Z0-9_-]{43}$/);
    kit.redact(guestToken);

    const ownerOut = await execCli([REMOTE, "issue", created.scriptId, "owner", "Backup Desktop"]);
    const ownerPayload = JSON.parse(ownerOut) as { id: string; role: string; token: string };
    assert.equal(ownerPayload.role, "owner");
    assert.match(ownerPayload.token, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(ownerOut.includes("?join="), false);
    kit.redact(ownerPayload.token);

    assert.equal((await run.owner(`scripts/${created.scriptId}/reset`, { method: "POST" }, guestToken)).status, 403);

    const listOut = await execCli([REMOTE, "list", created.scriptId]);
    const listed = JSON.parse(listOut) as { id: string; label: string; role: string; state: string }[];
    assert.equal(listed.some(entry => entry.label === "Clip Editor" && entry.role === "guest" && entry.state === "active"), true);
    assert.equal(listed.some(entry => entry.id === ownerPayload.id && entry.label === "Backup Desktop" && entry.role === "owner" && entry.state === "active"), true);
    assert.equal(listOut.includes(guestToken), false);
    assert.equal(listOut.includes(ownerPayload.token), false);

    const resetLink = await execCli([REMOTE, "reset", created.scriptId]);
    const resetUrl = new URL(resetLink);
    assert.equal(resetUrl.origin, REMOTE);
    assert.equal(resetUrl.searchParams.get("join"), created.scriptId);
    const newGuestToken = resetUrl.hash.slice(1);
    assert.match(newGuestToken, /^[a-zA-Z0-9_-]{43}$/);
    assert.notEqual(newGuestToken, guestToken);
    kit.redact(newGuestToken);

    const oldGuest = kit.copy(port, { kind: "empty" }, created.scriptId, guestToken);
    const refused = await kit.until(() => oldGuest.events.find(event => event.kind === "authentication-failed"));
    assert.equal(refused.reason, "invitation-revoked");

    const newGuest = kit.copy(port, { kind: "empty" }, created.scriptId, newGuestToken);
    await kit.until(() => (newGuest.relay.status().firstSyncDone && newGuest.text() === "word") || undefined);

    const ownerCopy = kit.copy(port, { kind: "empty" }, created.scriptId, ownerPayload.token);
    await kit.until(() => (ownerCopy.relay.status().firstSyncDone && ownerCopy.text() === "word") || undefined);

    assert.equal(await execCli([REMOTE, "revoke", ownerPayload.id]), "");
    const ownerRevoked = await kit.until(() => ownerCopy.events.find(event => event.kind === "authentication-failed"));
    assert.equal(ownerRevoked.reason, "access-removed");

    assert.equal(await execCli([REMOTE, "delete", created.scriptId]), "");
    const guestClosed = await kit.until(() => newGuest.events.find(event => event.kind === "authentication-failed"));
    assert.equal(guestClosed.reason, "access-removed");

    const scriptsAfterDelete = JSON.parse(await execCli([REMOTE, "scripts"])) as { id: string; status: string; untouched: boolean }[];
    assert.equal(
      scriptsAfterDelete.some(entry => entry.id === created.scriptId && entry.status === "deleted" && entry.untouched === false),
      true
    );

    assert.deepEqual(await run.stop("clean"), { code: 0, exitSignal: null });
    const logs = run.output() + run.errors();
    for (const sensitive of [secret, created.owner.token, created.guest.token, guestToken, ownerPayload.token, newGuestToken]) {
      assert.equal(logs.includes(sensitive), false);
    }
  }
);

test("owner CLI enforces https origin, secret presence, valid role and argument counts without leaking secrets", async () => {
  const secret = randomBytes(32).toString("base64url");
  const runProc = (args: readonly string[], env: NodeJS.ProcessEnv = { SPLITPAGE_MANAGEMENT_SECRET: secret }) =>
    spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });

  const missingSecret = runProc([REMOTE, "scripts"], {});
  assert.equal(missingSecret.status, 1);
  assert.match(missingSecret.stderr, /Set SPLITPAGE_MANAGEMENT_SECRET/);

  for (const badArgs of [
    ["http://relay.example.test", "scripts"],
    [REMOTE, "scripts", "extra"],
    [REMOTE, "issue", "script-1", "LabelWithoutRole"],
    [REMOTE, "issue", "script-1", "admin", "BadRole"],
    [REMOTE, "issue", "script-1", "guest", "   "],
    [REMOTE, "reset"],
    [REMOTE, "reset", "script-1", "extra"],
    [REMOTE, "unknown", "script-1"]
  ]) {
    const result = runProc(badArgs);
    assert.equal(result.status, 1, JSON.stringify(badArgs));
    assert.match(result.stderr, /^Usage: node owner-command\.ts/);
    assert.equal((result.stdout + result.stderr).includes(secret), false);
  }

  await assert.rejects(
    runOwnerCommand([REMOTE, "scripts"], { SPLITPAGE_MANAGEMENT_SECRET: secret }, {
      fetch: async () => new Response(null, { status: 401 })
    }),
    /Relay refused the command \(HTTP 401\)\./
  );
});
