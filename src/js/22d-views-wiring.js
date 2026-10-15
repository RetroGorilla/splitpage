import { owned } from "../features/routing/owned.ts";
import { runFromButton, saveFromButton } from "../legacy/app-actions.ts";
import { mountNotices } from "../features/notices/mount.ts";
import { mountPrompterVisibility, mountPrompterOpen, mountPrompter } from "../features/prompter/mount.ts";
import { mountIdentity, mountServer, mountDrive } from "../features/settings/mount.ts";
import { mountHistory } from "../features/history/mount.ts";
import { mountSaveRecovery, mountConflicts, mountSave, mountFileMenu } from "../features/file-menu/mount.ts";
import { mountImports, mountGdoc } from "../features/imports/mount.ts";
import { mountWriterOpen, mountWriterNavigation, mountWriterClose } from "../features/writer/mount.ts";
import { mountHistoryGallery } from "../features/gallery/mount.ts";
import { S } from "./_state.js";
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { conn, importHome } from "./_home.js";
import { expandHiddenShotStrip } from "./01b-hide-shot.js";
import {
  closeHistoryPanel,
  promptForName,
  promptForWpm,
  restoreSnapshotFromCard
} from "./03-sync.js";
import { initSidePanelResizeHandles } from "./03b-side-panels.js";
import { openGalleryOverlay } from "./05e-gallery-overlay.js";
import {
  clearPendingFileRows,
  captureImportPreview,
  closeGdocModal,
  closeImportModal,
  confirmGdocImport,
  confirmImport,
  handleImportFile,
  maybeAutoDetectTwoColumn,
  updateImportPreview
} from "./11-import.js";
import { showToast, updateSaveStatus } from "./12-dirty-toast.js";
import {
  armDriveDelete,
  armServerDelete,
  captureServerPicker,
  closeDriveModal,
  closeServerPicker,
  driveCancelRename,
  driveConnect,
  driveCreateFolder,
  driveCrumbTo,
  driveItemById,
  driveListCurrent,
  driveOpenItem,
  driveSaveCredsFromForm,
  driveSaveRename,
  driveShowCredsForm,
  driveSignIn,
  driveSignOut,
  driveStartRename,
  driveUploadFiles,
  openServerDoc,
  toggleDriveNewFolder
} from "./13-hosted.js";
import { saveDoc } from "./14-export.js";
import {
  buildFileData,
  closeFileConflict,
  deliverFile,
  exportAs,
  fileConflictCtx,
  handleFileMenuAction,
  hideResumeBanner,
  openProjectFile,
  pendingResumeHandle,
  reloadFileFromDisk,
  reloadProjectFromDisk,
  resumeFromHandle,
  saveBackToFile
} from "./18-local-files.js";
import { cancelMergeReview, confirmFileMerge, openMergeReview } from "./18a-local-merge.js";
import { toggleFileMenu, toggleSubmenu } from "./18b-file-menu.js";
import { applyWriterSize, closeWriter, jumpFromWriterToRow } from "./19-writer.js";
import {
  acquireWakeLock,
  disposePrompterView,
  applyPrompterSize,
  buildPrompterContent,
  closePrompter,
  cueSceneForCurrentPosition,
  promptSceneMode,
  prompterFlip,
  prompterMirror,
  setPrompterFlip,
  setPrompterMirror,
  setPrompterPlaying,
  setPrompterSceneMode,
  setPrompterSpeed,
  startVoiceFollow,
  stepPrompterSize,
  stepPrompterSpeed,
  stepScene,
  stopVoiceFollow,
  updatePrompterStatus,
  updateSceneReadout,
  updateVoiceAvailability
} from "./20-teleprompter.js";
import {
  dismissDesktopAppNotice,
  dismissUpdateNotice,
  loadUpdateStatus,
  renderDesktopAppNotice
} from "./20a-update.js";
import { finishMarkdownRowChoice } from "./20d-formats.js";
import { onRootClick, routeRootClick } from "./22a-editor-wiring.js";

var viewMounts = new Map();

function replaceViewMount(key, mount, routes) {
  var slot = viewMounts.get(key);
  if (!slot) {
    slot = owned();
    viewMounts.set(key, slot);
  }
  return slot.replace(mount, routes);
}

export function stopViewFeature(key) {
  var slot = viewMounts.get(key);
  if (slot) slot.stop();
}

function captureViewDocument() {
  var context = captureOperation();
  return function () { return stillOwns(context); };
}

export function mountNoticesFeature() {
  return replaceViewMount("mountNotices", function () {
    return mountNotices({ window: window, ports: {
      loadUpdateStatus: loadUpdateStatus,
      dismissUpdateNotice: dismissUpdateNotice,
      renderDesktopAppNotice: renderDesktopAppNotice,
      dismissDesktopAppNotice: dismissDesktopAppNotice
    } });
  });
}

export function mountPrompterVisibilityFeature() {
  return replaceViewMount("mountPrompterVisibility", function () {
    return mountPrompterVisibility({ window: window, ports: {
      acquireWakeLock: function (active) {
        var ownsDocument = captureViewDocument();
        acquireWakeLock(function () { return active() && ownsDocument(); });
      },
      isOpen: function () { return S.prompterOpen; }
    } });
  });
}

export function mountIdentityFeature() {
  return replaceViewMount("mountIdentity", function () {
    return mountIdentity({ window: window, ports: {
      promptForName: promptForName
    } });
  });
}

export function mountHistoryFeature() {
  return replaceViewMount("mountHistory", function () {
    return mountHistory({ window: window, ports: {
      promptForWpm: promptForWpm,
      closeHistoryPanel: closeHistoryPanel,
      onRootClick: onRootClick
    } });
  });
}

export function mountServerFeature() {
  return replaceViewMount("mountServer", function () {
    return mountServer({ window: window, ports: {
      closeServerPicker: closeServerPicker,
      openServerDoc: openServerDoc,
      armServerDelete: armServerDelete,
      routeOpen: function (id) { return S.DESKTOP ? S.DESKTOP.routeOpen({ kind: "server", serverDocId: id, serverUrl: conn.serverUrl, token: conn.token, tunnel: conn.tunnel }).then(function (result) { return !!result && result.where === "this-tab"; }) : null; },
      capture: function () {
        var ownsDocument = captureViewDocument();
        var ownsModal = captureServerPicker();
        return function () { return ownsDocument() && ownsModal(); };
      }
    } });
  });
}

export function mountDriveFeature() {
  return replaceViewMount("mountDrive", function () {
    return mountDrive({ window: window, ports: {
      closeDriveModal: closeDriveModal,
      driveSaveCredsFromForm: driveSaveCredsFromForm,
      driveShowCredsForm: driveShowCredsForm,
      driveConnect: driveConnect,
      driveCrumbTo: driveCrumbTo,
      driveOpenItem: driveOpenItem,
      driveListCurrent: driveListCurrent,
      toggleDriveNewFolder: toggleDriveNewFolder,
      driveCreateFolder: driveCreateFolder,
      driveSignIn: driveSignIn,
      driveSignOut: driveSignOut,
      driveStartRename: driveStartRename,
      driveSaveRename: driveSaveRename,
      driveCancelRename: driveCancelRename,
      driveItemById: driveItemById,
      armDriveDelete: armDriveDelete,
      driveUploadFiles: driveUploadFiles
    } });
  });
}

export function mountSaveRecoveryFeature() {
  return replaceViewMount("mountSaveRecovery", function () {
    return mountSaveRecovery({ window: window, ports: {
      hideResumeBanner: hideResumeBanner,
      resumeFromHandle: resumeFromHandle,
      showToast: showToast,
      saveDoc: saveDoc,
      exportAs: exportAs,
      pendingHandle: function () { return pendingResumeHandle; },
      capture: captureViewDocument
    } });
  });
}

export function mountConflictsFeature() {
  return replaceViewMount("mountConflicts", function () {
    return mountConflicts({ window: window, ports: {
      closeFileConflict: closeFileConflict,
      reloadProjectFromDisk: reloadProjectFromDisk,
      reloadFileFromDisk: reloadFileFromDisk,
      saveDoc: saveDoc,
      saveBackToFile: saveBackToFile,
      openMergeReview: openMergeReview,
      cancelMergeReview: cancelMergeReview,
      confirmFileMerge: confirmFileMerge,
      importHome: importHome,
      buildFileData: buildFileData,
      deliverFile: deliverFile,
      conflict: function () { return fileConflictCtx; },
      capture: captureViewDocument
    } });
  });
}

export function mountPanelsFeature() {
  return replaceViewMount("mountPanels", function () {
    return { dispose: initSidePanelResizeHandles() };
  });
}

export function mountSaveFeature() {
  return replaceViewMount("mountSave", function () {
    return mountSave({ window: window, ports: {
      saveFromButton: saveFromButton,
      updateSaveStatus: updateSaveStatus
    } });
  });
}

export function mountPrompterOpenFeature() {
  return replaceViewMount("mountPrompterOpen", function () {
    return mountPrompterOpen({ window: window, ports: {
      runFromButton: runFromButton
    } });
  });
}

export function mountFileMenuFeature() {
  return replaceViewMount("mountFileMenu", function () {
    return mountFileMenu({ window: window, ports: {
      toggleFileMenu: toggleFileMenu,
      toggleSubmenu: toggleSubmenu,
      handleFileMenuAction: handleFileMenuAction,
      openProjectFile: openProjectFile
    } });
  });
}

export function mountImportsFeature() {
  return replaceViewMount("mountImports", function () {
    return mountImports({ window: window, ports: {
      finishMarkdownRowChoice: finishMarkdownRowChoice,
      closeImportModal: closeImportModal,
      confirmImport: confirmImport,
      clearPendingFileRows: clearPendingFileRows,
      maybeAutoDetectTwoColumn: maybeAutoDetectTwoColumn,
      updateImportPreview: updateImportPreview,
      handleImportFile: handleImportFile,
      touchMode: function () { S.importModeTouched = true; },
      capture: function () {
        var ownsDocument = captureViewDocument();
        var ownsModal = captureImportPreview();
        return function () { return ownsDocument() && ownsModal(); };
      }
    } });
  });
}

export function mountGdocFeature() {
  return replaceViewMount("mountGdoc", function () {
    return mountGdoc({ window: window, ports: {
      closeGdocModal: closeGdocModal,
      confirmGdocImport: confirmGdocImport
    } });
  });
}

export function mountPrompterFeature() {
  return replaceViewMount("mountPrompter", function () {
    return mountPrompter({ window: window, ports: {
      disposeRuntime: disposePrompterView,
      closePrompter: closePrompter,
      stopVoiceFollow: stopVoiceFollow,
      startVoiceFollow: startVoiceFollow,
      setPrompterPlaying: setPrompterPlaying,
      setPrompterSpeed: setPrompterSpeed,
      applyPrompterSize: applyPrompterSize,
      stepPrompterSpeed: stepPrompterSpeed,
      stepPrompterSize: stepPrompterSize,
      updatePrompterStatus: updatePrompterStatus,
      buildPrompterContent: buildPrompterContent,
      updateVoiceAvailability: updateVoiceAvailability,
      cueSceneForCurrentPosition: cueSceneForCurrentPosition,
      updateSceneReadout: updateSceneReadout,
      setPrompterMirror: setPrompterMirror,
      setPrompterFlip: setPrompterFlip,
      setPrompterSceneMode: setPrompterSceneMode,
      stepScene: stepScene,
      voiceActive: function () { return S.voiceFollowActive; },
      playing: function () { return S.prompterPlaying; },
      isOpen: function () { return S.prompterOpen; },
      skipShot: function () { return S.prompterSkipShot; },
      setSkipShot: function (value) { S.prompterSkipShot = value; },
      mirror: function () { return prompterMirror; },
      flip: function () { return prompterFlip; },
      sceneMode: function () { return promptSceneMode; }
    } });
  });
}

export function mountWriterOpenFeature() {
  return replaceViewMount("mountWriterOpen", function () {
    return mountWriterOpen({ window: window, ports: {
      runFromButton: runFromButton
    } });
  });
}

export function mountWriterNavigationFeature() {
  return replaceViewMount("mountWriterNavigation", function () {
    return mountWriterNavigation({ window: window, ports: {
      jumpFromWriterToRow: jumpFromWriterToRow,
      expandHiddenShotStrip: expandHiddenShotStrip,
      saveFromButton: saveFromButton,
      applyWriterSize: applyWriterSize
    } });
  });
}

export function mountWriterCloseFeature() {
  return replaceViewMount("mountWriterClose", function () {
    return mountWriterClose({ window: window, ports: {
      closeWriter: closeWriter
    } });
  });
}

export function mountHistoryGalleryFeature() {
  return replaceViewMount("mountHistoryGallery", function () {
    return mountHistoryGallery({ restore: restoreSnapshotFromCard, open: openGalleryOverlay });
  }, function (owner) {
    return [
      function () { return routeRootClick("history-restore", function (e) { return owner.restoreClick(e); }); },
      function () { return routeRootClick("gallery", function (e) { return owner.galleryClick(e); }); }
    ];
  });
}
