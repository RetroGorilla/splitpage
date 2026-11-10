import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import * as Y from "yjs";
import { inspectUpdateDependencies } from "../../../src/service/refusal/dependencies.ts";
import { characterIdentities, fixture, until, workspace } from "../harness.ts";
import { frame, RefusalClient } from "./harness.ts";

const cases = [
  { name: "same-client gap", dependency: { gaps: ["11:0..1"], references: ["origin:11:0"], deletions: [] },
    final: ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "e:11:0", "f:11:1"] },
  { name: "cross-client origin", dependency: { gaps: [], references: ["origin:11:0"], deletions: [] },
    final: ["a:7:0", "b:7:1", "c:7:2", "d:7:3", "e:11:0", "f:22:0"] },
  { name: "delete before insertion", dependency: { gaps: [], references: [], deletions: ["11:0..1"] },
    final: ["a:7:0", "b:7:1", "c:7:2", "d:7:3"] },
] as const;

export async function observeDependencies(t: TestContext): Promise<void> {
  for (const row of cases) {
    await t.test(`Y13 / H2: ${row.name}, missing update first, duplicate, prerequisite, late join`, async () => {
      const work = await workspace();
      const clients: RefusalClient[] = [];
      const source = fixture();
      try {
        const server = await work.start({ REFUSAL_POLICY: "1" });
        const sender = new RefusalClient(server.port, ["accepted"]);
        clients.push(sender);
        await sender.connect(); await sender.saved();
        const initialVector = Y.encodeStateVector(source);
        source.getText("R1").insert(4, "e");
        const prerequisite = Y.encodeStateAsUpdate(source, initialVector);
        const nextVector = Y.encodeStateVector(source);
        if (row.name === "cross-client origin") source.clientID = 22;
        if (row.name === "delete before insertion") source.getText("R1").delete(4, 1);
        else source.getText("R1").insert(5, "f");
        const missing = Y.encodeStateAsUpdate(source, nextVector);
        assert.deepEqual(inspectUpdateDependencies(missing, initialVector), row.dependency);
        sender.expect("accepted", "accepted");
        sender.socket.send(frame(2, missing)); sender.socket.send(frame(2, missing));
        await until(() => sender.sent.length === 3 && sender.sent.every(item => item.applied === true), "pending and duplicate journal receipts");
        const partial = new RefusalClient(server.port, ["accepted"], new Y.Doc());
        clients.push(partial);
        await partial.connect(); await partial.saved();
        assert.deepEqual(characterIdentities(partial.document), ["a:7:0", "b:7:1", "c:7:2", "d:7:3"]);
        sender.expect("accepted"); sender.socket.send(frame(2, prerequisite));
        await until(() => sender.sent.at(-1)?.applied === true, "prerequisite journal receipt");
        const late = new RefusalClient(server.port, ["accepted"], new Y.Doc());
        clients.push(late);
        await late.connect(); await late.saved();
        assert.deepEqual(characterIdentities(late.document), row.final);
        for (const client of clients) client.checkJournal(work.path);
        assert.equal(server.stderr.includes("exception"), false);
      } finally { source.destroy(); for (const client of clients) client.destroy(); await work.clean(); }
    });
  }
}
