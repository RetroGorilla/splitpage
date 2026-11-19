import assert from "node:assert/strict";
import test from "node:test";
import { silentReconnect } from "../../src/native-relay/silent.ts";
import { openLink } from "../../src/native-relay/link.ts";
import { openCopy, openRelay, until } from "../../src/native-relay/relay.ts";

test("a silent socket forces 4408 and loses the tag after the retained queue drains", async t => {
  const result = await silentReconnect(350);
  assert.equal(result.code, 4408);
  assert.deepEqual(result.final, [{ insert: "v" }]);
  assert.equal(result.events.some(event => event[0] === "disconnect" && event[1] === true), true);
  t.diagnostic(JSON.stringify(result));
});

test("an early positive status can emit synced before the server's state reply applies", async () => {
  const relay = await openRelay();
  try {
    const link = await openLink(relay.address.port);
    try {
      let early = false;
      const writer = openCopy(link.url, 2, {}, undefined, { onOpen() {
        if (early) writer.doc.getText("mine").insert(0, "m");
      } });
      const reader = openCopy(relay.webSocketURL, 1);
      try {
        writer.connect(); reader.connect();
        await until(() => [writer, reader].every(copy => copy.provider.synced && !copy.provider.hasUnsyncedChanges), "initial signal pair");
        link.cut();
        await until(() => writer.closeEvents.length > 0 && !writer.provider.synced, "ordinary close before signal probe");
        writer.socket.disconnect();
        reader.doc.getText("remote").insert(0, "r");
        await until(() => !reader.provider.hasUnsyncedChanges, "remote change accepted before reconnect");
        const atSynced: string[] = [];
        writer.provider.on("synced", () => { atSynced.push(writer.doc.getText("remote").toString()); });
        early = true;
        writer.connect();
        await until(() => writer.doc.getText("remote").length === 1 && reader.doc.getText("mine").length === 1 &&
          !writer.provider.hasUnsyncedChanges, "inbound reply after early status");
        assert.deepEqual(atSynced, [""]);
        assert.equal(writer.doc.getText("remote").toString(), "r");
        assert.equal(reader.doc.getText("mine").toString(), "m");
      } finally { writer.close(); reader.close(); }
    } finally { await link.close(); }
  } finally { await relay.destroy(); }
});
