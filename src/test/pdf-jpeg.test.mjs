import "./_dom.mjs";
import "./_export-services-started.mjs";
import { liveWithAssets } from "./_export-now.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../bootstrap/document-ports.ts";
import { assemblePdf, pdfImagesFor } from "../adapters/formats/pdf.ts";
import { loadTestDocument } from "./_document.mjs";

const ADOBE = [0xFF, 0xEE, 0, 14, 0x41, 0x64, 0x6F, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0];
const SOS = [0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 0x3F, 0, 0x12, 0x34];

function jpeg(components, opts) {
  const o = opts || {};
  const w = o.w || 3, h = o.h || 2;
  const comps = [];
  for (let c = 1; c <= components; c++) comps.push(c, 0x11, 0);
  const sof = [0xFF, 0xC0, 0, 8 + 3 * components, 8, h >> 8, h & 255, w >> 8, w & 255, components, ...comps];
  return new Uint8Array([
    0xFF, 0xD8, ...(o.fill ? [0xFF, 0xFF] : []),
    ...(o.adobe === "before" ? ADOBE : []), ...(o.noSof ? [] : sof), ...(o.adobe === "after" ? ADOBE : []),
    ...(o.noSos ? [] : SOS), 0xFF, 0xD9
  ]);
}

function imageDict(bytes) {
  const out = assemblePdf({
    size: [612, 792],
    pages: [{ ops: [], images: ["Im1"] }],
    images: [{ name: "Im1", w: 3, h: 2, bytes }]
  });
  const t = Array.from(out, (b) => String.fromCharCode(b)).join("");
  const m = /<< \/Type \/XObject \/Subtype \/Image [^\n]*>>\nstream\n/.exec(t);
  assert.ok(m, "the image object is written");
  return m[0];
}

const RGB = "/ColorSpace /DeviceRGB /BitsPerComponent 8";

test("a one-component JPEG is DeviceGray", () => {
  const d = imageDict(jpeg(1));
  assert.ok(d.includes("/ColorSpace /DeviceGray /BitsPerComponent 8"));
  assert.ok(!d.includes("/Decode"));
});

test("a three-component JPEG is DeviceRGB", () => {
  const d = imageDict(jpeg(3));
  assert.ok(d.includes(RGB));
  assert.ok(!d.includes("/Decode"));
});

test("a four-component JPEG with an Adobe marker before the frame is DeviceCMYK and inverted", () => {
  const d = imageDict(jpeg(4, { adobe: "before" }));
  assert.ok(d.includes("/ColorSpace /DeviceCMYK /Decode [1 0 1 0 1 0 1 0] /BitsPerComponent 8"));
});

test("a four-component JPEG with an Adobe marker between the frame and the scan is inverted too", () => {
  const d = imageDict(jpeg(4, { adobe: "after" }));
  assert.ok(d.includes("/ColorSpace /DeviceCMYK /Decode [1 0 1 0 1 0 1 0] /BitsPerComponent 8"));
});

test("a four-component JPEG without an Adobe marker is DeviceCMYK with no Decode", () => {
  const d = imageDict(jpeg(4));
  assert.ok(d.includes("/ColorSpace /DeviceCMYK /BitsPerComponent 8"));
  assert.ok(!d.includes("/Decode"));
});

test("an Adobe marker does not change one or three components", () => {
  assert.ok(imageDict(jpeg(1, { adobe: "after" })).includes("/ColorSpace /DeviceGray /BitsPerComponent 8"));
  assert.ok(imageDict(jpeg(3, { adobe: "before" })).includes(RGB));
});

test("fill bytes before the frame header are skipped", () => {
  assert.ok(imageDict(jpeg(1, { fill: true })).includes("/ColorSpace /DeviceGray /BitsPerComponent 8"));
});

test("a header that is missing, truncated or inconsistent keeps DeviceRGB", () => {
  const cases = {
    "no frame header": jpeg(4, { noSof: true }),
    "frame length 2 beside a later APP0": new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 2, 0xFF, 0xE0, 0, 6, 0, 4, 0xFF, 0xD9]),
    "frame declares 20 and stops after the component count": new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 20, 8, 0, 2, 0, 3, 4]),
    "frame length does not fit the component count": new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 20, 8, 0, 2, 0, 3, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0, 0, ...SOS]),
    "a segment that runs past the end": new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 40, 1, 2, 3]),
    "frame with zero width": jpeg(4, { w: 0x10000 })
  };
  for (const name of Object.keys(cases)) assert.ok(imageDict(cases[name]).includes(RGB), name);
});

test("a valid frame header is enough when the scan header is missing", () => {
  const d = imageDict(jpeg(4, { adobe: "before", noSos: true }));
  assert.ok(d.includes("/ColorSpace /DeviceCMYK /Decode [1 0 1 0 1 0 1 0] /BitsPerComponent 8"));
});

test("the stream length is the JPEG's own", () => {
  const bytes = jpeg(4, { adobe: "before" });
  assert.ok(imageDict(bytes).includes("/Length " + bytes.length + " >>"));
});

async function sizesOf(bytes) {
  const b64 = Buffer.from(bytes).toString("base64");
  loadTestDocument(migrateRows({
    schema: 2, title: "Pic", comments: [],
    rows: [{ id: "r0", visualText: "x", audioText: "", status: "todo", visualImage: "data:image/jpeg;base64," + b64 }]
  }));
  const [doc, assets] = liveWithAssets();
  const out = await pdfImagesFor(doc, assets);
  return out[0] && out[0].size;
}

test("a JPEG with fill bytes before the frame keeps its own size and bytes", async () => {
  assert.deepEqual(await sizesOf(jpeg(3, { fill: true, w: 300, h: 200 })), { w: 300, h: 200 });
  assert.deepEqual(await sizesOf(jpeg(1, { adobe: "after", w: 40, h: 90 })), { w: 40, h: 90 });
});
