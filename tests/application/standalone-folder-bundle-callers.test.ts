import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilityPortCallers } from "./capability-caller-scan.ts";

const DESKTOP = "application/media/desktop-video.ts#DesktopVideo.";
const PORTS = "features/gallery/ports.ts#";

const FOLDERS = {
  [DESKTOP + "bundle"]: { "features/gallery/video-files.ts": 1 },
  [DESKTOP + "move"]: { "features/gallery/video-files.ts": 1 },
  "application/media/video-files.ts#VideoFiles.bundle": {
    "bootstrap/wiring/gallery.ts": 1, "bootstrap/wiring/video-files.ts": 1, "features/gallery/video-bundles.ts": 1
  },
  "application/media/video-files.ts#VideoFiles.move": {
    "bootstrap/wiring/gallery.ts": 1, "bootstrap/wiring/video-files.ts": 1, "features/gallery/video-bundles.ts": 1
  },
  [PORTS + "VideoBundlePorts.files"]: { "features/gallery/video-bundles.ts": 8 },
  [PORTS + "VideoBundlePorts.undo"]: { "features/gallery/video-bundles.ts": 1 },
  [PORTS + "VideoBundlePorts.cells"]: { "features/gallery/video-bundles.ts": 2 },
  [PORTS + "VideoBundleMount.offerAfterDrop"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video.ts": 1 },
  "bootstrap/wiring/gallery.ts#offerBundleAfterDrop": { "bootstrap/wiring/editor.ts": 1 }
};

const BUNDLES = {
  [DESKTOP + "planCreate"]: { "features/gallery/create-bundle.ts": 1 },
  [DESKTOP + "bundlePath"]: { "features/gallery/video-bundles.ts": 1 },
  [DESKTOP + "planExport"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video-bundles.ts": 2 },
  [DESKTOP + "pickExport"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video-bundles.ts": 1 },
  [DESKTOP + "exportBundle"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video-bundles.ts": 1 },
  [DESKTOP + "planSave"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video-bundles.ts": 1 },
  [DESKTOP + "chooseSave"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video-bundles.ts": 1 },
  [DESKTOP + "onCarry"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video-bundles.ts": 1 },
  [PORTS + "VideoBundlePorts.create"]: { "features/gallery/create-bundle.ts": 1, "features/gallery/video-bundles.ts": 1 },
  [PORTS + "VideoBundlePorts.exports"]: { "features/gallery/video-bundles.ts": 4 },
  [PORTS + "VideoBundlePorts.saves"]: { "features/gallery/video-bundles.ts": 2 },
  [PORTS + "VideoBundleMount.createBundle"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video.ts": 1 },
  [PORTS + "VideoBundleMount.exportPlan"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video.ts": 1 },
  [PORTS + "VideoBundleMount.exportWithFiles"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video.ts": 1 },
  [PORTS + "VideoBundleMount.beginSave"]: { "bootstrap/wiring/gallery.ts": 1, "features/gallery/video.ts": 1 },
  "features/gallery/create-bundle.ts#startCreateBundle": { "features/gallery/video-bundles.ts": 1 },
  "bootstrap/wiring/gallery.ts#createBundle": { "bootstrap/wiring/file-menu.ts": 1 },
  "bootstrap/wiring/gallery.ts#exportFilesPlan": { "bootstrap/wiring/exporters.ts": 1 },
  "bootstrap/wiring/gallery.ts#exportScriptWithFiles": { "bootstrap/wiring/ports/local-files.ts": 1 }
};

let inventory: ReturnType<typeof capabilityPortCallers> | null = null;

function current() {
  inventory ??= capabilityPortCallers([...Object.keys(FOLDERS), ...Object.keys(BUNDLES)], undefined, { references: true });
  return inventory;
}

for (const [family, expected] of [["folders", FOLDERS], ["bundles", BUNDLES]] as const) {
  test(family + " writers stay at the audited capability boundaries", () => {
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, current()[key]])), expected);
  });
}
