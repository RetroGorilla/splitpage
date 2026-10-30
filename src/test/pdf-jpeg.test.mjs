import test from "node:test";
import assert from "node:assert/strict";
import { assemblePdf } from "../adapters/formats/pdf.ts";

function jpeg(components, opts) {
  const o = opts || {};
  const adobe = o.adobe ? [0xFF, 0xEE, 0, 14, 0x41, 0x64, 0x6F, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0] : [];
  const sof = o.noSof ? [] : [0xFF, 0xC0, 0, 8 + 3 * components, 8, 0, 2, 0, 3, components];
  const parts = [];
  for (let c = 1; c <= components; c++) parts.push(c, 0x11, 0);
  return new Uint8Array([0xFF, 0xD8, ...adobe, ...(o.noSof ? [] : sof.concat(parts)), 0xFF, 0xD9]);
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

test("a one-component JPEG is DeviceGray", () => {
  const d = imageDict(jpeg(1));
  assert.ok(d.includes("/ColorSpace /DeviceGray /BitsPerComponent 8"));
  assert.ok(!d.includes("/Decode"));
});

test("a three-component JPEG is DeviceRGB", () => {
  const d = imageDict(jpeg(3));
  assert.ok(d.includes("/ColorSpace /DeviceRGB /BitsPerComponent 8"));
  assert.ok(!d.includes("/Decode"));
});

test("a four-component JPEG with an Adobe marker is DeviceCMYK and inverted", () => {
  const d = imageDict(jpeg(4, { adobe: true }));
  assert.ok(d.includes("/ColorSpace /DeviceCMYK /Decode [1 0 1 0 1 0 1 0] /BitsPerComponent 8"));
});

test("a four-component JPEG without an Adobe marker is DeviceCMYK with no Decode", () => {
  const d = imageDict(jpeg(4));
  assert.ok(d.includes("/ColorSpace /DeviceCMYK /BitsPerComponent 8"));
  assert.ok(!d.includes("/Decode"));
});

test("an Adobe marker does not change one or three components", () => {
  assert.ok(imageDict(jpeg(1, { adobe: true })).includes("/ColorSpace /DeviceGray /BitsPerComponent 8"));
  assert.ok(imageDict(jpeg(3, { adobe: true })).includes("/ColorSpace /DeviceRGB /BitsPerComponent 8"));
});

test("a JPEG with no frame header keeps DeviceRGB", () => {
  const d = imageDict(jpeg(3, { noSof: true }));
  assert.ok(d.includes("/ColorSpace /DeviceRGB /BitsPerComponent 8"));
});

test("the stream length and bytes are the JPEG's own", () => {
  const bytes = jpeg(4, { adobe: true });
  assert.ok(imageDict(bytes).includes("/Length " + bytes.length + " >>"));
});
