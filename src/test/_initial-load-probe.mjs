import { bootApp, closeApp } from "./_app-boot.mjs";
import { currentDocument } from "../legacy/session-bridge.ts";
import { documentLocation } from "../legacy/location-bridge.ts";

const pristine = process.argv[2] === "pristine";
const saved = JSON.stringify({ title: "Saved", rev: 3, lastEditedBy: "Ann", rows: [{ id: "r1", visualText: "", audioText: "x", status: "todo" }] });

globalThis.fetch = () => Promise.reject(new TypeError("no network in the initial-load probe"));
window.fetch = globalThis.fetch;
let error = null;
try {
  await bootApp(saved, { pristine });
} catch (failure) {
  error = String((failure && failure.stack) || failure);
}
const { deriveDocId } = await import("../core/document/ids.ts");
const report = {
  pristine,
  error,
  seedCheck: window.__onboarding ? window.__onboarding.seedCheckPasses() : null,
  title: currentDocument() ? currentDocument().title : null,
  docIdIsTheFiles: Boolean(currentDocument() && currentDocument().docId === deriveDocId("splitpage-file", saved)),
  writtenOut: documentLocation().writtenOut()
};
closeApp();
process.stdout.write(JSON.stringify(report) + "\n");
process.exit(0);
