type HistoryExport = Awaited<ReturnType<AppDataPorts["history"]["exportAll"]>>;
type HistoryImport = Awaited<ReturnType<AppDataPorts["history"]["importBundle"]>>;
type DataBundle = { format: string; version: number; exportedAt: string; appVersion: string | null | undefined; snapshots?: unknown; history?: HistoryExport | null; blobs?: Record<string, unknown>; missingBlobs?: readonly string[]; prefs?: unknown };
type ExportSummary = { ok: boolean; images: number; missingBlobs: string[]; truncated: boolean; warning: string | null };
type ImportSummary = { ok: boolean; history: HistoryImport | null; blobs: HistoryImport["blobs"] | null; prefs: string[]; legacy: number | null; toast: string; warning: string | null };
type DataError = Error & { code: string; secretKey?: string | null | undefined; canExportRest?: boolean };
import type { AppDataPorts } from "./ports.ts";
import { LEGACY_SNAPSHOTS_KEY } from "../../application/recovery/legacy-snapshots.ts";
import { settingsAppData } from "../../application/preferences/preferences.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

export function mountAppData(ports: AppDataPorts) {

const APPDATA_FORMAT = "splitpage-app-data";
const APPDATA_VERSION = 1;
const APPDATA_SECRET_RE = /token|api[-_]?key|client[-_]?id|secret|password|\bpin\b/i;
const HISTORY_READ_ERROR = "Export cancelled — history or image data could not be read. Nothing was downloaded.";
const TEMPORARY_READ_ERROR = "Export cancelled — history or image data could not be read right now. Please try again. Nothing was downloaded.";

function appDataReadRaw(key: string) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

function appDataReadJson(key: string, fallback: unknown) {
  const raw = appDataReadRaw(key);
  if (raw == null) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch (e) { return fallback; }
}

function appDataVersionString() {
  if (ports.desktop() && typeof ports.launchFacts.appVersion() === "string" && ports.launchFacts.appVersion()) return ports.launchFacts.appVersion();
  const embedded = typeof ports.embeddedVersion === "function" ? ports.embeddedVersion() : null;
  return embedded || "";
}

async function buildAppDataBundle(allowOmissions = false) {
  const bundle: DataBundle = {
    format: APPDATA_FORMAT,
    version: APPDATA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: appDataVersionString()
  };

  try {
    bundle.snapshots = appDataReadJson(LEGACY_SNAPSHOTS_KEY, null);
  } catch (e) {
    bundle.snapshots = null;
  }

  try {
    const history = await ports.history.exportAll({ allowOmissions });
    if (!history || !Array.isArray(history.docs) || !Array.isArray(history.older)) throw new Error("Invalid history export");
    if (history.omittedSnapshots && !history.older.length && !history.docs.some(function (doc) {
      return appDataIsPlainObject(doc) && Array.isArray(doc.snapshots) && doc.snapshots.length;
    })) throw new Error("No readable history could be exported");
    bundle.history = history;
    bundle.blobs = history.blobs || {};
    bundle.missingBlobs = history.missingBlobs || [];
    Reflect.deleteProperty(history, "blobs");
    Reflect.deleteProperty(history, "missingBlobs");
  } catch (e) {
    const failure = e as { code?: unknown; canExportRest?: unknown } | null;
    if (failure?.code === "temporary-read-failed") throw appDataError("temporary-read-failed", TEMPORARY_READ_ERROR);
    throw Object.assign(appDataError("history", HISTORY_READ_ERROR), { canExportRest: failure?.code === "read-failed" && failure.canExportRest === true });
  }

  try {
    bundle.prefs = ports.preferences.appDataExport(appDataExtraPrefs());
  } catch (e) {
    bundle.prefs = {};
  }

  return bundle;
}

function assertNoSecrets(value: unknown) {
  (function walk(v: unknown) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i]);
      return;
    }
    const keys = Object.keys(v);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (APPDATA_SECRET_RE.test(key as string)) {
        const e = new Error("Export cancelled — the bundle contained something that looks like a " +
          "credential (" + key + "). This is a bug; please report it.") as DataError;
        e.code = "secret";
        e.secretKey = key;
        throw e;
      }
      walk((v as Record<string, unknown>)[key as string]);
    }
  })(value);
}

function appDataFilename() {
  const d = new Date();
  function pad(n: number) { return n < 10 ? "0" + n : String(n); }
  return "splitpage-app-data-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".json";
}

let appDataLastExport: ExportSummary | null = null;
let readableExportNotice: WeakRef<ReturnType<AppDataPorts["notices"]["showAction"]>> | null = null;
let exporting = false;
let exportAttempt = 0;

async function exportAppData(allowOmissions = false) {
  if (exporting || disposed) return;
  exporting = true;
  const attempt = ++exportAttempt;
  try {
    readableExportNotice?.deref()?.dismiss();
    readableExportNotice = null;
    appDataLastExport = null;
    ports.notices.show("Gathering your Splitpage data…");
    await new Promise(function (resolve) { setTimeout(resolve, 0); });

    let bundle;
    try {
      bundle = await buildAppDataBundle(allowOmissions);
      assertNoSecrets(bundle);
    } catch (e) {
      const message = (e as Error | null)?.message || "Export cancelled — something went wrong building your app data.";
      if (!allowOmissions && (e as DataError | null)?.canExportRest && !disposed && attempt === exportAttempt) {
        readableExportNotice = new WeakRef(ports.notices.showAction(message, "error", "Export the rest anyway", function () {
          if (exporting || disposed || attempt !== exportAttempt) return;
          return exportAppData(true);
        }, true));
      } else ports.notices.show(message, "error");
      return;
    }
    if (allowOmissions && (disposed || attempt !== exportAttempt)) return;
    await deliverAppDataBundle(bundle);
  } finally { exporting = false; }
}

async function deliverAppDataBundle(bundle: DataBundle) {
  try { assertNoSecrets(bundle); } catch (e) {
    ports.notices.show((e as Error).message, "error");
    return;
  }
  let json;
  try {
    json = JSON.stringify(bundle, null, 2);
  } catch (e) {
    ports.notices.show("Could not build the export file.", "error");
    return;
  }

  const omitted = bundle.history?.omittedSnapshots || 0;
  const truncated = !!bundle.history?.truncated;
  const missing = bundle.missingBlobs || [];
  const saved = await ports.fileDelivery.deliver(appDataFilename(), json, { savedMsg: omitted || truncated || missing.length ? "Exported your Splitpage app data with omissions" : "Exported your Splitpage app data" });
  appDataLastExport = {
    ok: !!saved,
    images: Object.keys(bundle.blobs || {}).length,
    missingBlobs: missing.slice(),
    truncated: !!(bundle.history && bundle.history.truncated),
    warning: null
  };
  if (saved && missing.length) {
    appDataLastExport.warning = "Exported, but " + appDataPlural(missing.length, "image was", "images were") +
      " missing or unreadable and could not be included. The snapshots that use " +
      (missing.length === 1 ? "it" : "them") + " will show a placeholder.";
    if (window.console) console.warn("Export app data: images not included (bytes not found):", missing);
    ports.notices.show(appDataLastExport.warning, "warn", true);
  }
  if (saved && omitted) {
    const warning = "Exported, but " + appDataPlural(omitted, "damaged or unreadable history snapshot", "damaged or unreadable history snapshots") +
      " could not be included. Intact versions and their available images are included.";
    appDataLastExport.warning = [appDataLastExport.warning, warning].filter(Boolean).join(" ");
    ports.notices.show(appDataLastExport.warning, "warn", true);
  }
  if (saved && truncated) {
    const warning = "Exported, but some older history snapshots were left out to keep the file within the export size limit.";
    appDataLastExport.warning = [appDataLastExport.warning, warning].filter(Boolean).join(" ");
    ports.notices.show(appDataLastExport.warning, "warn", true);
  }
}

const APPDATA_MAX_TEXT = 512 * 1024 * 1024;

function appDataError(code: string, message: string) {
  const e = new Error(message) as DataError;
  e.code = code;
  return e;
}

function appDataIsPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function appDataNormalizeHistory(h: unknown) {
  if (!appDataIsPlainObject(h)) return null;
  return {
    docs: (Array.isArray(h.docs) ? h.docs : []).filter(appDataIsPlainObject).map(function (d) {
      return {
        docId: d.docId,
        title: typeof d.title === "string" ? d.title : "",
        lastOpenedAt: Number(d.lastOpenedAt) || 0,
        snapshots: Array.isArray(d.snapshots) ? d.snapshots : []
      };
    }),
    older: Array.isArray(h.older) ? h.older : [],
    truncated: !!h.truncated
  };
}

function appDataNormalizeBlobs(b: unknown) {
  if (!appDataIsPlainObject(b)) return null;
  const out: Record<string, unknown> = {};
  Object.keys(b).forEach(function (k) {
    if (k === "__proto__") return;
    out[k] = appDataIsPlainObject(b[k]) ? b[k] : null;
  });
  return out;
}

function appDataNormalizePrefs(p: unknown) {
  if (!appDataIsPlainObject(p)) return {};
  function str(v: unknown) { return typeof v === "string" ? v : null; }
  const out: Record<string, string | Record<string, unknown> | null> = {
    onboarding: appDataIsPlainObject(p.onboarding) ? p.onboarding : null,
    tourDone: str(p.tourDone),
    commentAuthor: str(p.commentAuthor),
    commentsSort: str(p.commentsSort),
    writerSize: str(p.writerSize),
    taggingHelpDismissed: str(p.taggingHelpDismissed),
    autosave: str(p.autosave)
  };
  settingsAppData().forEach(function (spec) { out[spec.name] = str(p[spec.name]); });
  return out;
}

function parseAppDataBundle(text: unknown) {
  if (typeof text !== "string") {
    throw appDataError("not-json", "That file isn't Splitpage app data (it isn't readable text).");
  }
  if (text.length > APPDATA_MAX_TEXT) {
    throw appDataError("too-large", "That file is too large to be Splitpage app data (over 512 MB).");
  }
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    throw appDataError("not-json", "That file isn't Splitpage app data (it isn't valid JSON).");
  }
  if (!appDataIsPlainObject(raw) || raw.format !== APPDATA_FORMAT ||
      typeof raw.version !== "number" || !isFinite(raw.version) || raw.version < 1) {
    throw appDataError("wrong-format", "That file isn't a Splitpage app data export.");
  }
  if (raw.version > APPDATA_VERSION) {
    throw appDataError("newer-version", "That app data was exported by a newer version of Splitpage. " +
      "Update this app, then import it again.");
  }
  try {
    assertNoSecrets(raw);
  } catch (e) {
    const refused = appDataError("secret", "Import refused — the file contains something that looks like a " +
      "credential (" + (((e as DataError | null) && (e as DataError).secretKey) || "unknown") + "). Splitpage never exports those, so this file " +
      "did not come from Splitpage.");
    refused.secretKey = (e as DataError | null) && (e as DataError).secretKey;
    throw refused;
  }
  return {
    format: APPDATA_FORMAT,
    version: raw.version,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : null,
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
    snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : null,
    history: appDataNormalizeHistory(raw.history),
    blobs: appDataNormalizeBlobs(raw.blobs),
    prefs: appDataNormalizePrefs(raw.prefs)
  };
}

function appDataExtraPrefs() {
  return settingsAppData();
}

function appDataMergePrefs(prefs: Parameters<AppDataPorts["preferences"]["appDataImport"]>[0]) {
  const written = ports.preferences.appDataImport(prefs, appDataExtraPrefs());
  try {
    if (written.indexOf("commentsSort") !== -1) ports.commentSorting.choose(ports.preferences.commentsSort());
    if (written.indexOf("writerSize") !== -1) ports.writer.setSize(ports.writer.size(), false);
  } catch (e) {}
  return written;
}

function appDataPlural(n: number, one: string, many: string) {
  return n + " " + (n === 1 ? one : many);
}

let appDataLastSummary: ImportSummary | { ok: boolean; code: string; message: string } | null = null;

async function importAppData(text: unknown) {
  let bundle;
  try {
    bundle = parseAppDataBundle(text);
  } catch (e) {
    const refused = { ok: false, code: ((e as DataError | null) && (e as DataError).code) || "invalid",
                    message: ((e as Error | null) && (e as Error).message) || "That file could not be imported." };
    appDataLastSummary = refused;
    ports.notices.show(refused.message, "error");
    return refused;
  }

  const summary: ImportSummary = { ok: true, history: null, blobs: null, prefs: [], legacy: null, toast: "", warning: null };

  let legacy: unknown[] = [];
  if (bundle.snapshots) {
    try { legacy = ports.history.normalizeSnapshots(JSON.stringify(bundle.snapshots)) || []; } catch (e) { legacy = []; }
    summary.legacy = legacy.length;
  }
  const hist = bundle.history || { docs: [] as unknown[], older: [] as unknown[] };
  summary.history = await ports.history.importBundle({ docs: hist.docs, older: hist.older.concat(legacy), blobs: bundle.blobs });
  summary.blobs = summary.history.blobs;

  try {
    summary.prefs = appDataMergePrefs(bundle.prefs);
  } catch (e) {
    if (window.console) console.error(e);
    summary.prefs = [];
  }

  const h = summary.history;
  const imgs = summary.blobs || { stored: 0, refused: [], failed: [] };
  const badImages = imgs.refused.length + imgs.failed.length;
  const snapshots = h.added + h.older;
  summary.toast = "Imported " + appDataPlural(snapshots, "version-history snapshot", "version-history snapshots") +
    " across " + appDataPlural(h.docs, "document", "documents") + " and your preferences.";
  ports.notices.show(summary.toast, "ok");

  if (h.skipped || h.failed || h.code || badImages) {
    if (window.console) {
      console.warn("Import app data: not everything was imported.", {
        history: h, prefsWritten: summary.prefs
      });
    }
  }
  if (h.failed || h.code) {
    if (h.code === "quota") {
      summary.warning = "Import stopped — storage is full. " +
        appDataPlural(h.failed, "snapshot was", "snapshots were") + " not imported.";
    } else {
      summary.warning = "Some app data could not be imported: " +
        appDataPlural(h.failed, "snapshot", "snapshots") + ". Details are in the console.";
    }
    ports.notices.show(summary.warning, "warn", true);
  }
  if (badImages) {
    const imgWarning = appDataPlural(badImages, "image", "images") + " in that file could not be imported" +
      " — the snapshots that use " + (badImages === 1 ? "it" : "them") + " will show a placeholder." +
      " Details are in the console.";
    summary.warning = summary.warning ? summary.warning + " " + imgWarning : imgWarning;
    ports.notices.show(summary.warning, "warn", true);
  }

  appDataLastSummary = summary;
  return summary;
}

let appDataInputWired = false;
let appDataInput: HTMLElement | null = null;

function openImportAppData() {
  const input = document.getElementById("import-app-data-input");
  if (!input) return;
  if (!appDataInputWired) {
    appDataInputWired = true;
    appDataInput = input;
    input.addEventListener("change", onImportAppDataChosen);
  }
  input.click();
}

async function onImportAppDataChosen(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files && input.files[0];
  if (!file) { input.value = ""; return; }
  try {
    if (file.size > APPDATA_MAX_TEXT) {
      ports.notices.show("That file is too large to be Splitpage app data (over 512 MB).", "error");
      return;
    }
    ports.notices.show("Importing your Splitpage data…");
    let text;
    try { text = await file.text(); } catch (err) {
      ports.notices.show("Could not read that file.", "error");
      return;
    }
    await importAppData(text);
  } finally {
    input.value = "";
  }
}

  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__appDataTest", function () {
    return {
      build: buildAppDataBundle,
      assertNoSecrets: assertNoSecrets,
      parse: parseAppDataBundle,
      importText: importAppData,
      summary: function () { return appDataLastSummary; },
      exportFile: exportAppData,
      exportSummary: function () { return appDataLastExport; },
      useBlobBackend: function (backend: Parameters<AppDataPorts["useBlobBackend"]>[0]) { ports.useBlobBackend(backend || null); return true; }
    };
  }, function (withdraw) { withdrawHook = withdraw; });
  let disposed = false;
  return {
    exportAppData: function () { if (!disposed) return exportAppData(); },
    openImportAppData: function () { if (!disposed) openImportAppData(); },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      readableExportNotice?.deref()?.dismiss();
      readableExportNotice = null;
      if (appDataInput) appDataInput.removeEventListener("change", onImportAppDataChosen);
      appDataInput = null;
      appDataInputWired = false;
      if (withdrawHook) withdrawHook();
    }
  };
}
