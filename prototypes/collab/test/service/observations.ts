import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import * as Y from "yjs";
import { syncFrame } from "../../src/service/wire.ts";
import { FixtureClient, fixture, journalRows, until, workspace } from "./harness.ts";

export async function observeHooks(t: TestContext): Promise<void> {
  await t.test("H1 / H7: raw beforeSync blocks apply, receipt and peer fanout; onChange does not block them", async () => {
    const work = await workspace();
    const clients: FixtureClient[] = [];
    try {
      const server = await work.start();
      const alice = new FixtureClient(server.port);
      clients.push(alice);
      await alice.connect(); await alice.saved();
      const bob = new FixtureClient(server.port, new Y.Doc());
      clients.push(bob);
      await bob.connect(); await bob.saved();
      const copy = fixture();
      const vector = Y.encodeStateVector(copy);
      copy.getText("R1").insert(4, "e");
      const update = Y.encodeStateAsUpdate(copy, vector);
      copy.destroy();
      await server.command("configure", { hold: Buffer.from(update).toString("base64"), changeHold: true });
      assert.deepEqual(alice.edit("e"), update);
      await until(() => server.events.some(e => e.event === "held"));
      const inspection = await server.command("inspect", {}, "inspection");
      assert.equal(journalRows(inspection).some(row => row.payload === Buffer.from(update).toString("base64")), false);
      assert.equal(bob.document.getText("R1").toString(), "abcd");
      assert.equal(alice.receipts.outstanding, 1);
      const before = server.events.findLast(e => e.event === "before");
      assert.equal(before?.text, "abcd");
      assert.equal(before.payload, Buffer.from(update).toString("base64"));
      server.child.send({ command: "release", gate: "held" });
      await until(() => server.events.some(e => e.event === "change-held"));
      await alice.saved();
      await until(() => bob.document.getText("R1").toString() === "abcde");
      server.child.send({ command: "release", gate: "change-held" });
    } finally { for (const client of clients) client.destroy(); await work.clean(); }
  });

  await t.test("H2 / Y15: stock path acknowledges swallowed decode errors and pending dependencies", async () => {
    const work = await workspace();
    let client: FixtureClient | undefined;
    try {
      const server = await work.start();
      client = new FixtureClient(server.port);
      await client.connect(); await client.saved();
      await server.command("configure", { unsafe: true });
      const copy = fixture();
      const vector = Y.encodeStateVector(copy);
      copy.getText("R1").insert(4, "e");
      const bad = Y.encodeStateAsUpdate(copy, vector).slice(0, -3);
      copy.destroy();
      client.socket.send(syncFrame("fixture", 2, bad));
      await until(() => client?.history.at(-1)?.applied === true);
      assert.match(server.stderr, /Caught error while handling a Yjs update/);
      const pendingDoc = new Y.Doc();
      pendingDoc.clientID = 99;
      pendingDoc.getText("R1").insert(0, "x");
      const pendingVector = Y.encodeStateVector(pendingDoc);
      pendingDoc.getText("R1").insert(1, "y");
      client.socket.send(syncFrame("fixture", 2, Y.encodeStateAsUpdate(pendingDoc, pendingVector)));
      pendingDoc.destroy();
      await until(() => client?.history.at(-1)?.applied === true);
      const inspection = await server.command("inspect", {}, "inspection");
      const recovered = new Y.Doc();
      try {
        Y.applyUpdate(recovered, Buffer.from(String(inspection.state), "base64"));
        assert.equal(recovered.getText("R1").toString(), "abcd");
      } finally { recovered.destroy(); }
    } finally { client?.destroy(); await work.clean(); }
  });

  for (const mode of ["invalid-update", "oversized-update", "write-failure", "invalid-step2", "hook-exception"] as const) {
    await t.test(`H2 / H10: ${mode} never enters journal or produces a positive receipt`, async () => {
      const work = await workspace();
      let client: FixtureClient | undefined;
      try {
        const server = await work.start();
        client = new FixtureClient(server.port);
        await client.connect(); await client.saved();
        client.socket.shouldConnect = false;
        const before = journalRows(await server.command("inspect", {}, "inspection"));
        await server.command("configure", { throwHook: mode === "hook-exception", failWrite: mode === "write-failure" });
        const copy = fixture();
        const vector = Y.encodeStateVector(copy);
        copy.getText("R1").insert(4, mode === "oversized-update" ? "x".repeat(2 * 1024 * 1024 + 1) : "e");
        let update = Y.encodeStateAsUpdate(copy, vector);
        copy.destroy();
        if (mode === "invalid-update" || mode === "invalid-step2") update = update.slice(0, -3);
        if (mode !== "invalid-update" && mode !== "invalid-step2") client.receipts.localUpdate(update);
        const start = client.history.length;
        client.socket.send(syncFrame("fixture", mode === "invalid-step2" ? 1 : 2, update));
        if (mode === "hook-exception" || mode === "invalid-step2") {
          await until(() => server.stderr.includes("because of exception"));
          assert.equal(client.history[start]?.applied, null);
        } else {
          await until(() => client?.history[start]?.applied === false);
          assert.equal(client.socket.webSocket?.readyState, 1);
          assert.equal(client.receipts.status, "Saved on this device, sending");
        }
        assert.equal(client.history[start]?.applied === true, false);
        assert.deepEqual(journalRows(await server.command("inspect", {}, "inspection")), before);
      } finally { client?.destroy(); await work.clean(); }
    });
  }

  await t.test("H5 / H6: flush returns before held store; immediate promise resolves even after store failure", async () => {
    const work = await workspace();
    let client: FixtureClient | undefined;
    try {
      const server = await work.start();
      client = new FixtureClient(server.port);
      await client.connect(); await client.saved();
      await server.command("configure", { storeHold: true });
      await server.command("store-schedule", {}, "scheduled-return");
      assert.equal(server.events.some(e => e.event === "store-start"), false);
      const flushed = await server.command("flush", {}, "flush-return");
      assert.equal(flushed.value, "undefined");
      await until(() => server.events.some(e => e.event === "store-held"));
      assert.equal(server.events.some(e => e.event === "store-end"), false);
      server.child.send({ command: "release", gate: "store-held" });
      await until(() => server.events.some(e => e.event === "store-end"));
      await server.command("configure", { storeHold: true, storeFailure: true });
      const start = server.events.length;
      server.child.send({ command: "store-immediate" });
      await until(() => server.events.slice(start).some(e => e.event === "store-held"));
      assert.equal(server.events.slice(start).some(e => e.event === "immediate-return"), false);
      server.child.send({ command: "release", gate: "store-held" });
      await until(() => server.events.slice(start).some(e => e.event === "immediate-return"));
      assert.match(server.stderr, /Document stays in memory to avoid data loss/);
      assert.equal(client.receipts.status, "Your changes saved to server");
      const inspection = await server.command("inspect", {}, "inspection");
      assert.equal(typeof inspection.state, "string");
    } finally { client?.destroy(); await work.clean(); }
  });
}
