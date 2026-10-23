import "./_dom.mjs";
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { checksumText } from "../../shared/text.js";
import { startupReady } from "../legacy/startup-bridge.ts";
import { currentDocument, onDocumentReplaced } from "../legacy/session-bridge.ts";

export const seen = [];

onDocumentReplaced(function () {
  const doc = currentDocument();
  seen.push({ site: "replaced", value: doc === null || doc === undefined ? doc : JSON.parse(JSON.stringify(doc)) });
});

const timers = new Set();
for (const [set, clear] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"]]) {
  const realSet = globalThis[set];
  const realClear = globalThis[clear];
  globalThis[set] = function (...args) { const id = realSet(...args); timers.add([realClear, id]); return id; };
  window[set] = globalThis[set];
  window[clear] = realClear;
}
const channels = new Set();
const NodeChannel = globalThis.BroadcastChannel;
class TrackedChannel extends NodeChannel {
  constructor(name) {
    super(name);
    channels.add(this);
  }
}
globalThis.BroadcastChannel = TrackedChannel;
window.BroadcastChannel = TrackedChannel;
for (const name of Object.getOwnPropertyNames(window)) {
  if (!(name in globalThis)) globalThis[name] = window[name];
}
for (const name of ["indexedDB", "IDBKeyRange"]) window[name] = globalThis[name];
const noMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
window.matchMedia = noMedia;
globalThis.matchMedia = noMedia;
const noRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
window.Range.prototype.getBoundingClientRect = noRect;
window.Range.prototype.getClientRects = () => [];
window.__splitpageNoNewTab = true;

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

export const SEED_TEXT = read("../seed-state.json");

function stateDataText(html) {
  return new window.DOMParser().parseFromString(html, "text/html").getElementById("state-data").textContent;
}

export async function bootApp(stateData, opts) {
    const page = read("../page.html").replace("{{VERSION}}", () => read("../../VERSION").trim());
  const shipped = opts && opts.pristine && stateData !== undefined ? stateData : SEED_TEXT;
  const seedText = stateDataText(page.replace("{{SEED_STATE}}", () => shipped));
  const check = seedText.length + "-" + checksumText(seedText);
  const filled = page
    .replace("{{SEED_CHECK}}", () => check)
    .replace("{{SEED_STATE}}", () => (stateData === undefined ? SEED_TEXT : stateData));
  const parsed = new window.DOMParser().parseFromString(filled, "text/html");
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  if (opts && opts.beforeStart) {
    Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
    try {
      await import("../js/_entry.js");
      opts.beforeStart();
    } finally {
      delete document.readyState;
    }
    document.dispatchEvent(new window.Event("DOMContentLoaded"));
  } else {
    await import("../js/_entry.js");
  }
  await startupReady();
  return seen.splice(0);
}

export function clearTimers() {
  for (const [clear, id] of timers) clear(id);
  timers.clear();
}

export function closeApp() {
  clearTimers();
  for (const channel of channels) channel.close();
}

export async function appWiringDeps() {
  const [{ migrateRows }, docId, sync, production, broll, dirty, exporting, drafts, hosted, files, imports, formats] = await Promise.all([
    import("../js/02-state.js"),
    import("../js/02b-doc-id.js"),
    import("../js/03-sync.js"),
    import("../js/07-production-tags.js"),
    import("../js/08c-broll.js"),
    import("../js/12-dirty-toast.js"),
    import("../js/14-export.js"),
    import("../js/20g-drafts.js"),
    import("../js/13-hosted.js"),
    import("../js/18-local-files.js"),
    import("../js/11-import.js"),
    import("../js/20d-formats.js")
  ]);
  return {
    entry: migrateRows,
    effects: dirty.legacySessionEffects(),
    editorName: sync.getEditorName,
    refresh: production.runIdleRefresh,
    records: broll.derivedRecordsPlan,
    bulkTags: { cell: production.bulkTagCell, stamp: sync.stampRow },
    saves: exporting.legacySavePorts,
    destinations: () => [exporting.legacyFileDestination(), files.importSaveDestination(), hosted.serverSaveDestination()],
    transitions: { destination: sync.documentDestinationPort, identity: docId.documentIdentityPort, history: sync.documentHistoryPort },
    sources: () => [files.projectFileSource(), imports.importDocumentSource(), hosted.serverDocumentSource()],
    merge: sync.legacyMergePorts,
    recovery: drafts.draftRecoveryPorts,
    projectFiles: formats.legacyProjectFileServices,
    keyTarget: window
  };
}

export async function rewireApp(overrides) {
  const { wireApp } = await import("../bootstrap/wiring.ts");
  return wireApp(Object.assign(await appWiringDeps(), overrides));
}

export async function rewireRunningApp(overrides) {
  const app = await import("../bootstrap/app.ts");
  app.stopApp();
  app.startApp(await rewireApp(overrides));
  await startupReady();
}
