import assert from "node:assert/strict";
import test from "node:test";
import { messageYjsSyncStep2 } from "y-protocols/sync";
import { openLink } from "../../src/native-relay/link.ts";
import { pairs, runPair } from "../../src/native-relay/pairs.ts";
import { openCopy, openRelay, until } from "../../src/native-relay/relay.ts";
import { silentReconnect } from "../../src/native-relay/silent.ts";
import { StateFirstProvider } from "../../src/native-relay/state-first.ts";

test("the stock and queue-only probes distinguish an offline redo from a direct send at open", async () => {
  const pair = pairs[0];
  assert(pair);
  const expected = (await runPair(pair, "ordered")).current;
  assert.notDeepEqual((await runPair(pair, "queued")).current.marks, expected.marks);
  assert.deepEqual((await runPair(pair, "queue-only")).current, expected);
  assert.notDeepEqual((await runPair(pair, "early")).current.marks, expected.marks);
  for (const schedule of ["wrapped", "wrapped-early"] as const) {
    assert.deepEqual((await runPair(pair, schedule)).current, expected);
  }
});

test("one state reply per returning writer preserves offline text, also with simultaneous returns", async () => {
  for (const together of [false, true]) {
    const returned: string[] = [];
    const relay = await openRelay({ async beforeSync({ connection, type }) {
      const writer = new URL(connection.request.url).searchParams.get("writer");
      if (writer && type === messageYjsSyncStep2) returned.push(writer);
    } });
    try {
      const first = await openLink(relay.address.port);
      try {
        const second = await openLink(relay.address.port);
        try {
          const copies = [openCopy(`${first.url}/?writer=A`, 1, {}, undefined, { Provider: StateFirstProvider }),
            openCopy(`${second.url}/?writer=B`, 2, {}, undefined, { Provider: StateFirstProvider }), openCopy(relay.webSocketURL, 3)];
          const [a, b, reader] = copies as [typeof copies[number], typeof copies[number], typeof copies[number]];
          try {
            for (const copy of copies) copy.connect();
            await until(() => copies.every(copy => copy.provider.synced && !copy.provider.hasUnsyncedChanges), "initial wrapper copies");
            first.cut();
            if (together) second.cut();
            const offline = together ? [a, b] : [a];
            await until(() => offline.every(copy => copy.closeEvents.length > 0), "wrapper copies closed");
            for (const copy of offline) copy.socket.disconnect();
            const start = returned.length;
            for (let index = 0; index < 80; index++) a.doc.getText("a").insert(index, "a");
            b.doc.getText("b").insert(0, "bb");
            for (const copy of offline) assert.equal(copy.provider.unsyncedChanges, 1);
            assert.equal(reader.doc.getText("a").length, 0);
            for (const copy of offline) copy.connect();
            await until(() => copies.every(copy => copy.doc.getText("a").length === 80 && copy.doc.getText("b").length === 2 &&
              !copy.provider.hasUnsyncedChanges), "both wrapper uploads applied");
            assert.deepEqual(returned.slice(start).sort(), together ? ["A", "B"] : ["A"]);
            for (const copy of copies) {
              assert.equal(copy.doc.getText("a").toString(), "a".repeat(80));
              assert.equal(copy.doc.getText("b").toString(), "bb");
            }
          } finally { for (const copy of copies) copy.close(); }
        } finally { await second.close(); }
      } finally { await first.close(); }
    } finally { await relay.destroy(); }
  }
});

test("a state-first reconnect keeps the tag after a silent watchdog close", async () => {
  const result = await silentReconnect(350, true);
  assert.deepEqual(result.final, [{ insert: "v", attributes: { "t:T1\u001f2.0": true } }]);
  assert.deepEqual(result.frames.map(frame => frame.kind), ["state"]);
});
