import "./_dom.mjs";
import { getEditorName } from "../legacy/preferences-bridge.ts";
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { checksumText } from "../../shared/text.js";
import { startupReady } from "../application/startup-signal.ts";
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
  const [{ migrateRows }, docId, sync, production, broll, effects, exporting, drafts, hosted, files, imports, formats] = await Promise.all([
    import("../legacy/document-ports.ts"),
    import("../bootstrap/wiring/document-identity.ts"),
    import("../bootstrap/wiring/session-merge.ts"),
    import("../features/tags/production-tags.js"),
    import("../bootstrap/wiring/broll.ts"),
    import("../bootstrap/wiring/session-effects.ts"),
    import("../bootstrap/wiring/file-saving.ts"),
    import("../bootstrap/wiring/drafts.ts"),
    import("../js/13-hosted.js"),
    import("../js/18-local-files.js"),
    import("../bootstrap/wiring/imports.ts"),
    import("../bootstrap/wiring/project-files.ts")
  ]);
  const entry = await import("../bootstrap/startup/document-entry.js");
  const html = await import("../adapters/page/standalone-html.js");
  const fileSaving = exporting.wireFileSaving({ copyHistory: (...args) => docId.documentIdentityOwner().copyDocHistorySafe(...args), syncIdentity: (...args) => docId.documentIdentityOwner().syncDocIdentity(...args), setBaseline: sync.setBaseState });
  return {
    entry: migrateRows,
    effects: effects.sessionEffects(),
    editorName: getEditorName,
    refresh: (await import("../bootstrap/wiring/production-tags.ts")).wireTagProduction().refresh,
    records: broll.derivedRecordsPlan,
    bulkTags: { cell: production.bulkTagCell, stamp: sync.stampRow },
    saves: fileSaving.savePorts,
    destinations: () => [fileSaving.destination(), files.importSaveDestination(), hosted.serverSaveDestination()],
    transitions: { destination: sync.documentDestinationPort, identity: docId.documentIdentityPort, history: sync.documentHistoryPort },
    sources: () => [files.projectFileSource(), imports.importDocumentSource(), hosted.serverDocumentSource()],
    merge: sync.sessionMergePorts,
    recovery: drafts.draftRecoveryPorts,
    projectFiles: () => formats.wireProjectFiles({
      prepareDocument: entry.migrateDocument,
      restoreDocument: entry.adoptRestoredState,
      changeDocumentId: (...args) => docId.documentIdentityOwner().reassignDocId(...args),
      identityEvents: (...args) => docId.documentIdentityOwner().docIdEvents(...args),
      connectIdentity: (...args) => docId.documentIdentityOwner().initDocIdentityChannel(...args),
      standaloneHtml: html.standaloneHtmlFor,
      replaceSyncBase: sync.setBaseState,
      tagOccurrences: production.tagFieldOccurrences
    }).services,
    keyTarget: window
  };
}

export async function rewireApp(overrides) {
  const { wireApp } = await import("../bootstrap/wiring.ts");
  const wiring = wireApp(Object.assign(await appWiringDeps(), overrides));
  const { mountHistoryOwner } = await import("../bootstrap/wiring/history.ts");
  mountHistoryOwner();
  (await import("../bootstrap/wiring/session-merge.ts")).mountSessionMergeOwner();
  (await import("../bootstrap/wiring/document-identity.ts")).mountDocumentIdentityOwner();
  return wiring;
}

export async function rewireRunningApp(overrides) {
  const app = await import("../bootstrap/app.ts");
  app.stopApp();
  app.startApp(await rewireApp(overrides));
  await startupReady();
}
