import { fileURLToPath } from "node:url";
import { relative } from "node:path";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

export const CONFIGURATION = Object.freeze({
  "src/legacy/session-bridge.ts": { functions: ["startSessionBridge", "onDocumentReplaced", "onSessionChange", "onRefresh", "onStamped"] },
  "src/legacy/undo-adapter.ts": { functions: ["routeReplays"] },
  "src/js/12a-undo.js": { functions: ["configureUndo", "routeUndoReplays"] },
  "src/legacy/app-actions.ts": { functions: ["installAppActions"], facade: { name: "appActions", methods: ["register", "presentRefusals"] } },
  "src/legacy/export-formats.ts": { functions: ["installExportFormats"], facade: { name: "exportFormats", methods: ["defineCard", "register", "onChange"] } },
  "src/legacy/save-bridge.ts": { functions: ["startSaves", "onSaveChange"] },
  "src/legacy/transition-bridge.ts": { functions: ["startTransitions"] },
  "src/legacy/recovery-bridge.ts": { functions: ["startRecovery", "useBrowserDraftFactory"] },
  "src/legacy/merge-bridge.ts": { functions: ["startMerge", "installMergeBanner"] },
  "src/legacy/production-editing-bridge.ts": { functions: ["startProductionEditing"] },
  "src/legacy/production-index-bridge.ts": { functions: ["startProductionIndex"] },
  "src/legacy/editor-bridge.ts": { functions: ["startEditor", "installPicturePicker", "installCellEditing"] },
  "src/legacy/preferences-bridge.ts": { functions: ["startPreferences", "onPreferenceChange"] },
  "src/legacy/shot-hiding-bridge.ts": { functions: ["startShotHiding"] },
  "src/legacy/presence-bridge.ts": { functions: ["startPresence"] },
  "src/legacy/location-bridge.ts": { functions: ["startLocation", "handServerCheckTo"] },
  "src/legacy/effects-bridge.ts": { functions: ["startEffects"] },
  "src/legacy/panels-bridge.ts": { functions: ["startSidePanels"] },
  "src/legacy/tour-pause.ts": { functions: ["handTourPauseTo"] },
  "src/legacy/file-actions.ts": { functions: ["registerFileActions"] },
  "src/legacy/share-actions.ts": { functions: ["registerShareActions"] },
  "src/legacy/view-actions.ts": { functions: ["registerViewActions"] },
  "src/bootstrap/wiring/script-zoom.ts": { functions: ["mountScriptZoomFeature"] },
  "src/bootstrap/wiring/rundown.ts": { functions: ["mountRundownFeature"] },
  "src/bootstrap/wiring/find.ts": { functions: ["mountFindFeature", "mountFindEventsFeature"] },
  "src/bootstrap/wiring/help.ts": { functions: ["mountHelpFeature"] },
  "src/bootstrap/wiring/gallery.ts": { functions: ["mountGalleryFeature"] },
  "src/application/export/services.ts": { functions: ["installExportServices"] },
  "src/bootstrap/wiring/exporters.ts": { functions: ["registerBuiltInExporters"] },
  "src/bootstrap/wiring.ts": { functions: ["wireApp"] },
  "src/bootstrap/wiring/editor.ts": { functions: ["routeRootClick", "routeRootMouseDown", "onRootClick", "onRootMouseDown", "onRootInput", "onRootPaste", "onRootKeydown"] },
  "src/bootstrap/wiring/production-editing.ts": { functions: ["wireProductionEditing"] },
  "src/bootstrap/wiring/production.ts": { functions: ["mountTagsFeature"] },
  "src/bootstrap/wiring/comments.ts": { functions: ["mountCommentsFeature"] },
  "src/bootstrap/wiring/views.ts": { functions: ["mountTopbarFeature", "mountCellReachFeature", "mountPhoneBarFeature", "mountAppearanceFeature", "mountNoticesFeature", "mountPrompterVisibilityFeature", "mountIdentityFeature", "mountHistoryFeature", "mountServerFeature", "mountDriveFeature", "mountSaveRecoveryFeature", "mountConflictsFeature", "mountPanelsFeature", "mountSaveFeature", "mountPrompterOpenFeature", "mountFileMenuFeature", "mountImportsFeature", "mountGdocFeature", "mountPrompterFeature", "mountWriterOpenFeature", "mountWriterNavigationFeature", "mountWriterCloseFeature", "mountHistoryGalleryFeature"] },
  "src/bootstrap/wiring/overlay.ts": { functions: ["mountOverlayFeature"] },
  "src/bootstrap/wiring/startup.ts": { functions: ["startupPorts", "openInitialDocument"] },
  "src/bootstrap/app.ts": { functions: ["startApp", "startAppWhenReady"] },
  "src/bootstrap/effects.ts": { functions: ["startPageEffects"] },
  "src/bootstrap/actions.ts": { functions: ["startActions"] },
  "src/bootstrap/startup/page-lifetime.ts": { functions: ["watchHistoryMigration", "registerServiceWorker"] }
});

function record(file, name) {
  return "globalThis.__loadOrderCall?.(" + JSON.stringify(file) + ", " + JSON.stringify(name) + ", new Error().stack)";
}

export function spied(file, source) {
  const spec = CONFIGURATION[file];
  if (!spec) return source;
  const typed = file.endsWith(".ts");
  let out = source;
  for (const name of spec.functions) {
    const head = "export function " + name + "(";
    const rest = typed ? "...args: unknown[]" : "...args";
    out = out.replace(head, head + rest + ") {\n  " + record(file, name) + ";\n  return spied_" + name + ".apply(this, args);\n}\nfunction spied_" + name + "(");
  }
  if (spec.facade) {
    const { name, methods } = spec.facade;
    for (const method of methods) {
      out += "\n{\n  const real = " + name + "." + method + ";\n  " + name + "." + method + " = function (...args" + (typed ? ": unknown[]" : "") + ") {\n    " + record(file, name + "." + method) + ";\n    return Reflect.apply(real, this, args);\n  };\n}\n";
    }
  }
  return out;
}

let target = null;

export function initialize(data) {
  target = (data && data.target) || null;
}

export async function load(url, context, nextLoad) {
  if (target && url === new URL("_load-order-target.mjs", import.meta.url).href) {
    return { format: "module", source: "import " + JSON.stringify(target) + ";\n", shortCircuit: true };
  }
  const result = await nextLoad(url, context);
  if (!url.startsWith("file:")) return result;
  const file = relative(REPO, fileURLToPath(url)).split("\\").join("/");
  if (!CONFIGURATION[file]) return result;
  return { ...result, source: spied(file, String(result.source)) };
}
