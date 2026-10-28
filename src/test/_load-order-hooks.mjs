import { fileURLToPath } from "node:url";
import { relative } from "node:path";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

export const CONFIGURATION = Object.freeze({
  "src/bootstrap/wiring/export-capture.ts": { functions: ["startExportKit"] },
  "src/bootstrap/wiring/export-kit.ts": { functions: ["wireExportKit"] },
  "src/legacy/session-bridge.ts": { functions: ["startSessionBridge", "onDocumentReplaced", "onSessionChange", "onRefresh", "onStamped"] },
  "src/legacy/undo-adapter.ts": { functions: ["routeReplays"] },
  "src/legacy/undo-bridge.ts": { functions: ["startUndo", "configureUndo", "routeUndoReplays"] },
  "src/legacy/app-actions.ts": { functions: ["installAppActions"], facade: { name: "appActions", methods: ["register", "presentRefusals"] } },
  "src/bootstrap/wiring/export-registry.ts": { functions: ["installExportFormats"], facade: { name: "exportFormats", methods: ["defineCard", "register", "onChange"] } },
  "src/legacy/save-bridge.ts": { functions: ["startSaves", "onSaveChange"] },
  "src/legacy/transition-bridge.ts": { functions: ["startTransitions"] },
  "src/bootstrap/wiring/document-identity.ts": { functions: ["mountDocumentIdentityOwner"] },
  "src/application/identity/document-guard.ts": { functions: ["startDocumentGuard", "createDocumentGuard"] },
  "src/adapters/page/standalone-html.js": { functions: ["startStandaloneHtml"] },
  "src/legacy/recovery-bridge.ts": { functions: ["startRecovery", "useBrowserDraftFactory"] },
  "src/bootstrap/wiring/session-merge.ts": { functions: ["mountSessionMergeOwner"] },
  "src/bootstrap/wiring/history-panel.ts": { functions: ["mountHistoryPanelFeature"] },
  "src/bootstrap/wiring/title-chrome.ts": { functions: ["mountTitleChromeFeature"] },
  "src/bootstrap/wiring/ports/session-merge.ts": { functions: ["sessionMergeOwnerPorts"] },
  "src/legacy/merge-bridge.ts": { functions: ["startMerge", "installMergeBanner"] },
  "src/legacy/production-editing-bridge.ts": { functions: ["startProductionEditing"] },
  "src/application/production/index-owner.ts": { functions: ["startProductionIndex"] },
  "src/legacy/editor-bridge.ts": { functions: ["startEditor", "installPicturePicker", "installCellEditing"] },
  "src/legacy/preferences-bridge.ts": { functions: ["startPreferences", "onPreferenceChange"] },
  "src/bootstrap/wiring/shot-hiding.ts": { functions: ["startShotHiding"] },
  "src/legacy/location-bridge.ts": { functions: ["startLocation"] },
  "src/legacy/effects-bridge.ts": { functions: ["startEffects"] },
  "src/legacy/panels-bridge.ts": { functions: ["startSidePanels"] },
  "src/legacy/desktop-bridge.ts": { functions: ["startDesktopDocumentState", "handDesktopTo"] },
  "src/application/desktop/menu-commands.ts": { functions: ["runMenuCommandsWith"] },
  "src/bootstrap/wiring/script-zoom.ts": { functions: ["mountScriptZoomFeature"] },
  "src/bootstrap/wiring/read-time.ts": { functions: ["mountReadTimeFeature"] },
  "src/bootstrap/wiring/broll.ts": { functions: ["mountBrollFeature", "mountBrollPanelStateFeature"] },
  "src/bootstrap/wiring/scene-status.ts": { functions: ["mountSceneStatusFeature", "onScriptStats"] },
  "src/bootstrap/wiring/rundown.ts": { functions: ["mountRundownFeature", "mountTargetFeature"] },
  "src/bootstrap/wiring/find.ts": { functions: ["mountFindFeature", "mountFindEventsFeature"] },
  "src/bootstrap/wiring/onboarding.ts": { functions: ["mountOnboardingFeature"] },
  "src/bootstrap/wiring/drafts.ts": { functions: ["mountDraftsFeature"] },
  "src/bootstrap/wiring/desktop.ts": { functions: ["mountDesktopFeature", "startDesktopShell"] },
  "src/bootstrap/wiring/prompter.ts": { functions: ["mountPrompterRuntimeFeature"] },
  "src/bootstrap/wiring/help.ts": { functions: ["mountHelpFeature"] },
  "src/bootstrap/wiring/command-menu.ts": { functions: ["mountCommandMenuFeature"] },
  "src/bootstrap/wiring/history.ts": { functions: ["mountHistoryOwner"] },
  "src/bootstrap/wiring/settings.ts": { functions: ["mountSettingsFeature"] },
  "src/bootstrap/wiring/clipboard.ts": { functions: ["mountCopyPasteFeature"] },
  "src/bootstrap/wiring/render.ts": { functions: ["mountRowsRenderFeature"] },
  "src/bootstrap/wiring/rows.ts": { functions: ["mountScenesFeature", "mountSceneMediaFeature"] },
  "src/bootstrap/wiring/video-files.ts": { functions: ["mountVideoFilesFeature"] },
  "src/bootstrap/wiring/gallery.ts": { functions: ["mountGalleryFeature", "mountGalleryOverlayFeature", "mountGalleryVideoFeature"] },
  "src/bootstrap/wiring/hide-shot.ts": { functions: ["mountHideShotFeature"] },
  "src/bootstrap/wiring/production-tags.ts": { functions: ["mountProductionTagsFeature", "wireTagProduction"] },
  "src/bootstrap/wiring/plain-tags.ts": { functions: ["mountPlainTagsFeature"] },
  "src/bootstrap/wiring/merge-review.ts": { functions: ["mountMergeReviewFeature"] },
  "src/bootstrap/wiring/file-menu-export.ts": { functions: ["mountFileMenuExportFeature"] },
  "src/bootstrap/wiring/file-menu-controls.ts": { functions: ["onFileMenuRefresh", "startNewScript"] },
  "src/bootstrap/wiring/file-saving.ts": { functions: ["mountFileSavingFeature", "wireFileSaving"] },
  "src/bootstrap/wiring/save-status.ts": { functions: ["mountSaveStatusFeature"] },
  "src/application/export/services.ts": { functions: ["installExportServices"] },
  "src/application/settings-actions.ts": { functions: ["installSettingsControls"] },
  "src/bootstrap/wiring/exporters.ts": { functions: ["registerBuiltInExporters"] },
  "src/bootstrap/wiring.ts": { functions: ["wireApp"] },
  "src/bootstrap/wiring/editor.ts": { functions: ["routeRootClick", "routeRootMouseDown", "onRootClick", "onRootMouseDown", "onRootInput", "onRootPaste", "onRootKeydown"] },
  "src/bootstrap/wiring/production-editing.ts": { functions: ["wireProductionEditing"] },
  "src/bootstrap/wiring/production.ts": { functions: ["mountTagsFeature"] },
  "src/bootstrap/wiring/comments.ts": { functions: ["mountCommentsFeature", "mountCommentsLogicFeature"] },
  "src/bootstrap/wiring/views.ts": { functions: ["mountTopbarFeature", "mountCellReachFeature", "mountPhoneBarFeature", "mountAppearanceFeature", "mountNoticesFeature", "mountPrompterVisibilityFeature", "mountIdentityFeature", "mountHistoryFeature", "mountSaveRecoveryFeature", "mountConflictsFeature", "mountPanelsFeature", "mountSaveFeature", "mountPrompterOpenFeature", "mountFileMenuFeature", "mountImportsFeature", "mountGdocFeature", "mountPrompterFeature", "mountWriterOpenFeature", "mountWriterNavigationFeature", "mountWriterCloseFeature", "mountHistoryGalleryFeature"] },
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
