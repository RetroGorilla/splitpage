import assert from "node:assert/strict";
import { replicaFileFaults, replicasAt } from "./desktop-local-store-fixture.ts";

const [, , directory, name, point, payload] = process.argv;
assert.ok(directory && name && payload);
assert.ok(point === "append" || point === "checkpoint");
const { fileSystem, intercept } = replicaFileFaults();
const { invoke } = replicasAt(directory, fileSystem).window();
const opened = await invoke(["open", name]);
assert.equal(opened.kind, "opened");
if (point === "append") intercept("append:sync", async () => process.exit(0));
else intercept("checkpoint.new:rename", async rename => { await rename(); process.exit(0); });
await invoke(["write", name, opened.lease, 2, point === "checkpoint", Buffer.from(payload, "base64")]);
assert.fail("The write returned before the interruption");
