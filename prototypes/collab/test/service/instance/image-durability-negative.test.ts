import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import type { ClientRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import * as Y from "yjs";
import { imageService } from "../../../src/service/images/service.ts";
import { instanceRequest } from "../../../src/service/instance/client.ts";
import { until, workspace } from "../harness.ts";
import { imagePort, membership, png, sha, upload } from "../images/harness.ts";
import { OWNER, INVITE, createFixture } from "./harness.ts";
import { assertStoredP, pictureSeed } from "./image-harness.ts";
import { inspectInstance } from "./oracle.ts";

test("blob upload rechecks authorization after the held request body completes", async () => {
  const work = await workspace();
  let images: Awaited<ReturnType<typeof imageService>> | undefined;
  let outgoing: ClientRequest | undefined;
  let settled: Promise<unknown> | undefined;
  try {
    const server = await work.start({ INSTANCE_OWNER: OWNER });
    const fixture = await createFixture(server);
    fixture.source.destroy();
    let bodyReleased = false;
    const decisions: { state: string; bodyReleased: boolean }[] = [];
    images = await imageService(work.path, async (instance, token) => {
      const reader = new DatabaseSync(work.path, { readOnly: true });
      try {
        const record = reader.prepare("SELECT state, inviteHash FROM instances WHERE id=?").get(instance);
        const state = String(record?.state ?? "missing");
        decisions.push({ state, bodyReleased });
        if (state !== "committed" || record?.inviteHash !== createHash("sha256").update(token).digest("hex")) {
          throw new Error("Instance admission ended");
        }
      } finally { reader.close(); }
    });
    const response = new Promise<{ status: number }>((resolve, reject) => {
      outgoing = request(`http://127.0.0.1:${images?.port}/api/images/${fixture.id}/${sha}`, {
        method: "PUT", signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${INVITE}`, "Content-Type": "image/png", "Content-Length": png.byteLength },
      }, incoming => {
        incoming.once("error", reject);
        incoming.once("end", () => resolve({ status: incoming.statusCode ?? 0 }));
        incoming.resume();
      });
      outgoing.once("error", reject);
      outgoing.write(png.subarray(0, Math.floor(png.byteLength / 2)));
    });
    settled = response.catch(() => undefined);
    await until(() => decisions.length === 1, "initial upload admission while the harness withholds the body suffix");
    assert.deepEqual(decisions, [{ state: "committed", bodyReleased: false }]);
    const controller = new DatabaseSync(work.path);
    try {
      assert.equal(controller.prepare("UPDATE instances SET state='abandoned' WHERE id=?").run(fixture.id).changes, 1);
    } finally { controller.close(); }
    assert.equal(inspectInstance(work.path, fixture.id).instances[0]?.state, "abandoned");
    bodyReleased = true;
    assert.ok(outgoing);
    outgoing.end(png.subarray(Math.floor(png.byteLength / 2)));
    const result = await response;
    assert.deepEqual({
      status: result.status,
      decisions,
      files: await readdir(`${work.path}.images`),
      membership: membership(work.path, fixture.id),
    }, {
      status: 422,
      decisions: [{ state: "committed", bodyReleased: false }, { state: "abandoned", bodyReleased: true }],
      files: [], membership: [],
    });
  } finally {
    outgoing?.destroy(); await settled;
    await images?.close(); await work.clean();
  }
});

test("initial commit hashes stored P and refuses corrupted bytes despite intact membership", async () => {
  const work = await workspace(); let source: Y.Doc | undefined;
  try {
    const server = await work.start({ INSTANCE_OWNER: OWNER, IMAGE_POLICY: "1" });
    const operation = "corrupt-initial-P";
    const creation = await instanceRequest(server.port, OWNER, { action: "create", operation, invite: INVITE });
    const id = String(creation.id);
    source = pictureSeed("abcd", id, true);
    const uploaded = await upload(server, png, sha, { instance: id, token: OWNER });
    assert.equal(uploaded.status, 201); await uploaded.arrayBuffer();
    await assertStoredP(work.path, id);
    await instanceRequest(server.port, OWNER, { action: "upload", operation, payload: Buffer.from(Y.encodeStateAsUpdate(source)).toString("base64") });
    const corrupted = Buffer.from(png);
    corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 1;
    const storedPath = join(`${work.path}.images`, sha);
    await writeFile(storedPath, corrupted);
    const actualBytes = await readFile(storedPath);
    assert.deepEqual(actualBytes, corrupted);
    assert.notEqual(createHash("sha256").update(actualBytes).digest("hex"), sha);
    assert.deepEqual(membership(work.path, id), [sha]);
    await assert.rejects(assertStoredP(work.path, id), { name: "AssertionError" });
    const download = await fetch(`http://127.0.0.1:${imagePort(server)}/api/images/${id}/${sha}`, {
      headers: { Authorization: `Bearer ${OWNER}` }, signal: AbortSignal.timeout(8000),
    });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), corrupted);
    const refused = await fetch(`http://127.0.0.1:${server.port}/api/instance`, {
      method: "POST", headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "commit", operation }), signal: AbortSignal.timeout(8000),
    });
    await refused.arrayBuffer();
    const after = inspectInstance(work.path, id);
    assert.deepEqual({ status: refused.status, state: after.instances[0]?.state, rows: after.rows.length },
      { status: 409, state: "pending", rows: 0 });
    await writeFile(storedPath, png);
    await assertStoredP(work.path, id);
    await instanceRequest(server.port, OWNER, { action: "commit", operation });
    const repaired = inspectInstance(work.path, id);
    assert.equal(repaired.instances[0]?.state, "committed");
    assert.equal(repaired.rows.length, 1);
  } finally { source?.destroy(); await work.clean(); }
});
