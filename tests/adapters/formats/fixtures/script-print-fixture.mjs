import "../../../../src/test/_dom.mjs";
import "../../../../src/test/_export-services-started.mjs";
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { buildExportDocument } from "../../../../src/core/document/export-document.ts";
import { exportAssetRequest, heldExportAssets } from "../../../../src/application/export/assets.ts";
import { exportServices } from "../../../../src/application/export/services.ts";
import { migratedThenSet } from "../../../core/migrate-ports.ts";

function pngChunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
}

function fixturePicture() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(640, 0); header.writeUInt32BE(360, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((640 * 3 + 1) * 360);
  for (let y = 0; y < 360; y++) {
    for (let x = 0; x < 640; x++) {
      const offset = y * (640 * 3 + 1) + 1 + x * 3;
      pixels[offset] = 40; pixels[offset + 1] = 90 + Math.floor(y / 3); pixels[offset + 2] = 150 + Math.floor(x / 8);
    }
  }
  return Uint8Array.from(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]));
}

export const PNG = fixturePicture();
export const SHA = "a".repeat(64);
export const MISSING = "b".repeat(64);
export const REF = { sha256: SHA, mime: "image/png", width: 640, height: 360 };

export function scriptFixture(kind = "rich") {
  const visual = '<strong>Bold</strong> <em>italic</em> <u>underline</u> <s>strike</s> <mark>highlight</mark><br>' +
    '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Camera">Camera</span> ' +
    '<span class="broll-key" data-broll-id="shot-1">B-roll:</span> ' +
    '<a href="https://example.com/reference">Reference</a> <a href="javascript:alert(1)">unsafe link</a>';
  const audio = '<span class="cmt-anchor" data-cmt="c1">Captured words</span> ' +
    '<span class="stage-dir">whisper</span><br><span class="audio-cue">MUSIC: theme</span><br>中文 日本語 العربية हिन्दी 😀';
  const rows = kind === "empty" ? [] : [{ id: "r1", visualText: visual, audioText: audio, status: "ready", lengthSeconds: 12,
    imageRef: REF, moreImages: [{ imageRef: REF }, { imageRef: { ...REF, sha256: MISSING } }],
    imageLinks: [{ href: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", poster: true }, { name: "Local clip" }] }];
  if (kind === "long") {
    rows[0].visualText += "<br>" + Array.from({ length: 180 }, (_, i) => "Visual line " + i).join("<br>");
    rows[0].audioText += "<br>" + "Unbroken".repeat(120) + "<br>" + Array.from({ length: 160 }, (_, i) => "Audio line " + i).join("<br>");
    for (let i = 2; i <= 18; i++) rows.push({ id: "r" + i, visualText: "Scene " + i + " visual 中文", audioText: "Scene " + i + " audio العربية", status: "shot" });
  }
  const comments = kind === "empty" ? [] : [
    { id: "c1", rowId: "r1", field: "audioText", author: "Ann <script>", body: `Before<img data-blob="${SHA}">After`,
      quotedText: "Captured words", assignee: "Jo", createdAt: "2026-10-30T12:00:00Z", resolved: false,
      replies: [{ id: "reply", author: "Bob", body: `Reply<img data-blob="${MISSING}">End reply`, createdAt: "2026-10-30T12:01:00Z" }] },
    { id: "c2", rowId: "gone", field: "visualText", author: "Jo", body: "Resolved body", resolved: true, resolvedBy: "Sam", replies: [] },
    { id: "c3", field: "title", author: "Jo", body: "Title comment", replies: [] }
  ];
  const source = migratedThenSet({ schema: 2, title: "Captured <script> 中文 😀", wordsPerMinute: 150, targetSeconds: 60, rows, comments });
  const doc = buildExportDocument(source, "2026-10-30T13:00:00Z", { production: [], commentNumbers: { c1: 1 }, broll: [] }, { clockMode: "24" });
  const assets = heldExportAssets(exportAssetRequest([SHA, MISSING]), {
    load: () => Promise.resolve(), bytes: (sha) => sha === SHA ? PNG : null, mime: () => "image/png"
  });
  return { source, input: { doc, assets, services: exportServices() } };
}
