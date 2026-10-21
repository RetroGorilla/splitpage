import { bootApp, closeApp } from "./_app-boot.mjs";
import { S } from "../js/_state.js";

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
  title: S.state ? S.state.title : null,
  docIdIsTheFiles: Boolean(S.state && S.state.docId === deriveDocId("splitpage-file", saved)),
  writtenOut: S.docIdWrittenOut
};
closeApp();
process.stdout.write(JSON.stringify(report) + "\n");
process.exit(0);
