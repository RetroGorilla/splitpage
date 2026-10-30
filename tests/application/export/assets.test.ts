import test from "node:test";
import assert from "node:assert/strict";
import { exportAssetRequest, heldExportAssets, resolveExportAssets } from "../../../src/application/export/assets.ts";
import type { ExportAssetPorts } from "../../../src/application/export/assets.ts";

interface Rig {
  ports: ExportAssetPorts;
  log: string[];
}

function rig(store: Record<string, Uint8Array>, load?: (shas: readonly string[]) => Promise<unknown>): Rig {
  const log: string[] = [];
  return {
    log: log,
    ports: {
      load: function (shas) {
        log.push("load:" + shas.join(","));
        return load ? load(shas) : Promise.resolve();
      },
      bytes: function (sha) {
        log.push("bytes:" + sha);
        return store[sha] ?? null;
      },
      mime: function (sha) {
        log.push("mime:" + sha);
        return sha.startsWith("png") ? "image/png" : null;
      }
    }
  };
}

test("a request keeps first-seen order, drops repeats and non-string entries, and is frozen", () => {
  const request = exportAssetRequest(["b", "a", "b", 7 as unknown as string, "c", "a"]);
  assert.deepEqual(request.shas, ["b", "a", "c"]);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.shas));
});

test("an empty request holds nothing", () => {
  assert.deepEqual(exportAssetRequest([]).shas, []);
});

test("sha strings that collide with object keys are kept as ordinary names", () => {
  assert.deepEqual(exportAssetRequest(["__proto__", "constructor", "__proto__"]).shas, ["__proto__", "constructor"]);
});

test("held assets give the bytes and mime of each found picture and list the missing ones in order", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const r = rig({ png1: bytes });
  const held = heldExportAssets(exportAssetRequest(["gone1", "png1", "gone2"]), r.ports);
  assert.deepEqual(held.shas, ["gone1", "png1", "gone2"]);
  assert.deepEqual(held.missing, ["gone1", "gone2"]);
  const picture = held.picture("png1");
  assert.equal(picture?.bytes, bytes);
  assert.equal(picture?.mime, "image/png");
  assert.equal(held.picture("gone1"), null);
  assert.equal(held.picture("never-asked"), null);
});

test("a picture whose mime is unknown is still held, with a null mime", () => {
  const r = rig({ raw1: new Uint8Array([9]) });
  const held = heldExportAssets(exportAssetRequest(["raw1"]), r.ports);
  assert.equal(held.picture("raw1")?.mime, null);
  assert.deepEqual(held.missing, []);
});

test("held assets read the ports once, at the time they are made, never later", () => {
  const r = rig({ png1: new Uint8Array([1]) });
  const held = heldExportAssets(exportAssetRequest(["png1"]), r.ports);
  const calls = r.log.length;
  held.picture("png1");
  held.picture("png1");
  assert.equal(r.log.length, calls);
});

test("the held record, its picture entries and the missing list are frozen", () => {
  const r = rig({ png1: new Uint8Array([1]) });
  const held = heldExportAssets(exportAssetRequest(["png1", "gone"]), r.ports);
  assert.ok(Object.isFrozen(held));
  assert.ok(Object.isFrozen(held.missing));
  assert.ok(Object.isFrozen(held.picture("png1")));
});

test("resolving loads the pictures first, then holds what is now available", async () => {
  const store: Record<string, Uint8Array> = {};
  const r = rig(store, function () {
    store["png1"] = new Uint8Array([5]);
    return Promise.resolve();
  });
  const held = await resolveExportAssets(exportAssetRequest(["png1"]), r.ports);
  assert.equal(r.log[0], "load:png1");
  assert.deepEqual(held.missing, []);
  assert.deepEqual(Array.from(held.picture("png1")?.bytes ?? []), [5]);
});

test("resolving an empty request never calls load", async () => {
  const r = rig({});
  const held = await resolveExportAssets(exportAssetRequest([]), r.ports);
  assert.deepEqual(r.log, []);
  assert.deepEqual(held.shas, []);
  assert.deepEqual(held.missing, []);
});

test("a rejected load is swallowed and the pictures already available are still held", async () => {
  const r = rig({ png1: new Uint8Array([1]) }, function () { return Promise.reject(new Error("offline")); });
  const held = await resolveExportAssets(exportAssetRequest(["png1", "gone"]), r.ports);
  assert.deepEqual(held.missing, ["gone"]);
  assert.ok(held.picture("png1"));
});
