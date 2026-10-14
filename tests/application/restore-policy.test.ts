import { test } from "node:test";
import assert from "node:assert/strict";
import { neverWrittenOut } from "../../src/application/recovery/pristine.ts";
import { restoreOwnership } from "../../src/application/recovery/restore-policy.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";

interface Now {
  epoch: number;
  docId: string | null;
  destination: unknown;
  connection: unknown;
}

function owner(now: Now) {
  function capture(): OperationContext {
    return Object.freeze({
      epoch: now.epoch, docId: now.docId, destination: now.destination,
      destinationGeneration: 0, generation: 0, connection: now.connection, revision: null
    });
  }
  return restoreOwnership({
    capture: capture,
    stillOwns: function (ctx: OperationContext): boolean {
      return ctx.epoch === now.epoch && ctx.docId === now.docId &&
        ctx.destination === now.destination && ctx.connection === now.connection;
    }
  });
}

const FILE = Object.freeze({ kind: "file" });
const SERVER = Object.freeze({ kind: "server" });

test("a restore owns the document while its epoch, id and destination hold", () => {
  const now: Now = { epoch: 3, docId: "d1", destination: FILE, connection: {} };
  const o = owner(now);
  const ctx = o.capture();
  assert.equal(o.stillOwns(ctx), true);
  now.epoch = 4;
  assert.equal(o.stillOwns(ctx), false, "a same-id reopen is a new epoch (H1, K1)");
  now.epoch = 3;
  now.docId = "d2";
  assert.equal(o.stillOwns(ctx), false, "another document");
  now.docId = "d1";
  now.destination = Object.freeze({ kind: "file" });
  assert.equal(o.stillOwns(ctx), false, "another destination, even of the same kind");
});

test("a connection change matters only to a restore on a server document", () => {
  const onFile: Now = { epoch: 1, docId: "d1", destination: FILE, connection: {} };
  const file = owner(onFile);
  const fileCtx = file.capture();
  onFile.connection = {};
  assert.equal(file.stillOwns(fileCtx), true, "a file or unsaved document never used the connection");
  const onServer: Now = { epoch: 1, docId: "d1", destination: SERVER, connection: {} };
  const server = owner(onServer);
  const serverCtx = server.capture();
  onServer.connection = {};
  assert.equal(server.stillOwns(serverCtx), false);
});

test("#483: a document is never written out when it has no revision and no editor name once normalised", () => {
  assert.equal(neverWrittenOut({ rev: 0, lastEditedBy: "" }), true);
  assert.equal(neverWrittenOut({ rev: 0, lastEditedBy: "   " }), true, "a whitespace-only name is no name");
  assert.equal(neverWrittenOut({}), true);
  assert.equal(neverWrittenOut(null), true);
  assert.equal(neverWrittenOut({ rev: 2, lastEditedBy: "" }), false);
  assert.equal(neverWrittenOut({ rev: 0, lastEditedBy: "Sam" }), false);
});
