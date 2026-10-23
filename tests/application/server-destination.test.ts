import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_DESTINATION, SERVER_SAVE_FAILED_HALT, createServerDestination } from "../../src/application/save/server-destination.ts";
import type { SaveJob } from "../../src/application/save/coordinator.ts";

interface Request {
  readonly kind: string;
}

interface Bench {
  readonly log: string[];
  sent: boolean;
  signedOut: boolean;
  linkOff: boolean;
}

function bench(): { b: Bench; server: ReturnType<typeof createServerDestination<Request>> } {
  const b: Bench = { log: [], sent: true, signedOut: false, linkOff: false };
  const server = createServerDestination<Request>({
    send: (job) => { b.log.push("send " + job.request.kind); return Promise.resolve(b.sent); },
    signedOut: () => b.signedOut,
    linkOff: () => b.linkOff,
    resumeAutoSave: () => { b.log.push("resume"); },
    haltAutoSave: (reason) => { b.log.push("halt " + reason); }
  });
  return { b, server };
}

function job(kind: string): SaveJob<Request> {
  return { request: { kind }, generation: 1, operation: () => { throw new Error("unused"); }, owns: () => true, alive: () => true, moved: () => {} };
}

const SERVER_HOME = { kind: "server" };

test("the server destination takes a server save anywhere, and Save, autosave and a forced save only when the document lives on the server", () => {
  const { server } = bench();
  assert.equal(server.id, SERVER_DESTINATION);
  assert.equal(server.takes({ kind: "server" }, { kind: "file" }), true);
  assert.equal(server.takes({ kind: "server" }, null), true);
  for (const kind of ["save", "auto", "autosave", "force"]) {
    assert.equal(server.takes({ kind }, SERVER_HOME), true, kind + " on the server");
    assert.equal(server.takes({ kind }, { kind: "file" }), false, kind + " in a file");
    assert.equal(server.takes({ kind }, null), false, kind + " with no place");
  }
  for (const kind of ["saveAs", "writeback", "writebackForce"]) {
    assert.equal(server.takes({ kind }, SERVER_HOME), false, kind + " is never the server's");
  }
});

test("autosave goes to the server unless the session expired or the link was turned off", () => {
  const { b, server } = bench();
  assert.equal(server.autoSaveTarget(SERVER_HOME), "server");
  b.linkOff = true;
  assert.equal(server.autoSaveTarget(SERVER_HOME), null);
  b.linkOff = false;
  b.signedOut = true;
  assert.equal(server.autoSaveTarget(SERVER_HOME), null);
});

test("a manual or forced save resumes autosave before sending; an automatic or explicit server save does not", async () => {
  for (const [kind, resumes] of [["save", true], ["force", true], ["auto", false], ["autosave", false], ["server", false]] as const) {
    const { b, server } = bench();
    assert.deepEqual(await server.write(job(kind)), { kind: "saved" }, kind);
    assert.deepEqual(b.log, resumes ? ["resume", "send " + kind] : ["send " + kind], kind);
  }
});

test("a send that did not go through fails, and pauses autosave only when the save was automatic", async () => {
  for (const [kind, halts] of [["save", false], ["force", false], ["server", false], ["auto", true], ["autosave", true]] as const) {
    const { b, server } = bench();
    b.sent = false;
    assert.deepEqual(await server.write(job(kind)), { kind: "failed" }, kind);
    assert.equal(b.log.includes("halt " + SERVER_SAVE_FAILED_HALT), halts, kind);
  }
});
