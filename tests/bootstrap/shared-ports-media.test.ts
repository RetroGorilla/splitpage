import "../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { blobImgHtml, has, setBackend } from "../../src/adapters/storage/02c-blobs.js";
import { sharedPorts } from "../../src/bootstrap/wiring/shared-ports.ts";
import { captureOperation, stillOwns } from "../../src/legacy/transition-bridge.ts";
import { image } from "../../src/test/golden-helpers.mjs";
import { fakeOwnership, fakePictures } from "../features/fakes.ts";

function recordingBackend(puts: string[]) {
  return {
    name: "recorder",
    persistent: true,
    get: () => Promise.resolve(null),
    put: (sha: string) => {
      puts.push(sha);
      return Promise.resolve();
    },
    missing: (shas: string[]) => Promise.resolve(shas.slice())
  };
}

test("operation ownership is the transition bridge's capture and stillOwns", () => {
  const { ownership } = sharedPorts();
  assert.equal(ownership.capture, captureOperation);
  assert.equal(ownership.stillOwns, stillOwns);
});

test("the picture store interns, reads, renders and persists through the blob store", async () => {
  const { pictures } = sharedPorts();
  const pic = image("png", 23, 17);
  const puts: string[] = [];
  setBackend(recordingBackend(puts));
  try {
    assert.equal(has(pic.sha256), false);
    const ref = pictures.intern(pic.bytes as Uint8Array);
    assert.deepEqual(ref, pic.record);
    assert.deepEqual(pictures.recordFor(pic.sha256), pic.record);
    assert.deepEqual(pictures.bytesFor(pic.sha256), pic.bytes);
    assert.match(pictures.dataUrlFor(pic.sha256) ?? "", /^data:image\/png;base64,/);
    assert.equal(pictures.imgHtml(pic.record, "thumb"), blobImgHtml(pic.record, "thumb"));
    assert.deepEqual(await pictures.ensureBytes([pic.sha256]), []);
    assert.equal(pictures.isDurable(pic.sha256), false);
    assert.deepEqual(await pictures.persist([pic.sha256]), []);
    assert.deepEqual(puts, [pic.sha256]);
    assert.equal(pictures.isDurable(pic.sha256), true);
    assert.deepEqual(pictures.internDataUrl(pic.dataUrl), pic.record);
  } finally {
    setBackend(null);
  }
});

test("the fakes keep the ports' shape: a replaced document ends ownership, a forgotten picture is missing", async () => {
  const owned = fakeOwnership();
  const ctx = owned.ownership.capture();
  assert.equal(owned.ownership.stillOwns(ctx), true);
  owned.replace();
  assert.equal(owned.ownership.stillOwns(ctx), false);
  const store = fakePictures();
  const ref = store.pictures.intern(new Uint8Array([1, 2]));
  assert.ok(ref);
  assert.equal(store.pictures.recordFor(ref.sha256), ref);
  store.forget(ref.sha256);
  assert.deepEqual(await store.pictures.ensureBytes([ref.sha256]), [ref.sha256]);
  await store.pictures.persist([ref.sha256]);
  assert.equal(store.pictures.isDurable(ref.sha256), true);
});
