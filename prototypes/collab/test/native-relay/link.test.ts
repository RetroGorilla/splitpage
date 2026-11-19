import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { openLink } from "../../src/native-relay/link.ts";
import { openCopy, openRelay, until } from "../../src/native-relay/relay.ts";

test("a small first sync finishes through the capped stream and with the cap removed", async t => {
  const seed = new Y.Doc();
  const expected = "abcdef".repeat(12_000);
  let stored: Uint8Array;
  try {
    seed.clientID = 900;
    seed.getText("script").insert(0, expected);
    stored = Y.encodeStateAsUpdate(seed);
  } finally { seed.destroy(); }
  const run = async (rate: number) => {
    const server = await openRelay({ async onLoadDocument() { return stored; } });
    try {
      const link = await openLink(server.address.port, rate);
      try {
        const reader = openCopy(link.url, 1);
        try {
          const start = performance.now();
          reader.connect();
          await until(() => reader.provider.synced && reader.doc.getText("script").length === expected.length, "small first sync");
          assert.equal(reader.doc.getText("script").toString(), expected);
          assert.equal(reader.closeEvents.length, 0);
          assert.equal(link.connections, 1);
          assert(link.bytes.download >= stored.length);
          return { pacedBytes: link.paced.download, ms: Math.round(performance.now() - start) };
        } finally { reader.close(); }
      } finally { await link.close(); }
    } finally { await server.destroy(); }
  };
  const capped = await run(1), uncapped = await run(Infinity);
  assert(capped.pacedBytes >= stored.length);
  assert(capped.ms >= 500);
  assert.equal(uncapped.pacedBytes, 0);
  t.diagnostic(`small sync capped ${capped.ms} ms, uncapped ${uncapped.ms} ms`);
});
