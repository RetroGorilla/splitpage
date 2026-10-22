import type { Disposable, Owned } from "../../features/routing/owned.ts";
import type { NoticesPorts } from "../../features/notices/mount.ts";
import type { PrompterVisibilityPorts, PrompterOpenPorts, PrompterPorts } from "../../features/prompter/mount.ts";
import type { IdentityPorts, ServerPorts, DrivePorts } from "../../features/settings/mount.ts";
import type { AppearancePorts } from "../../features/settings/appearance.ts";
import type { HistoryPorts } from "../../features/history/mount.ts";
import type { SaveRecoveryPorts, ConflictsPorts, SavePorts, FileMenuPorts } from "../../features/file-menu/mount.ts";
import type { ImportsPorts, GdocPorts } from "../../features/imports/mount.ts";
import type { WriterOpenPorts, WriterNavigationPorts, WriterClosePorts } from "../../features/writer/mount.ts";
import type { HistoryGalleryPorts } from "../../features/gallery/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { runFromButton, saveFromButton } from "../../legacy/app-actions.ts";
import { mountNotices } from "../../features/notices/mount.ts";
import { mountPrompterVisibility, mountPrompterOpen, mountPrompter } from "../../features/prompter/mount.ts";
import { mountIdentity, mountServer, mountDrive } from "../../features/settings/mount.ts";
import { mountAppearance } from "../../features/settings/appearance.ts";
import { mountHistory } from "../../features/history/mount.ts";
import { mountSaveRecovery, mountConflicts, mountSave, mountFileMenu } from "../../features/file-menu/mount.ts";
import { mountImports, mountGdoc } from "../../features/imports/mount.ts";
import { mountWriterOpen, mountWriterNavigation, mountWriterClose } from "../../features/writer/mount.ts";
import { mountHistoryGallery } from "../../features/gallery/mount.ts";
import { touchImportMode } from "../../application/import-mode.ts";
import {
  prompterIsOpen,
  prompterIsPlaying,
  prompterSkipsShot,
  setPrompterSkipShot,
  voiceIsFollowing
} from "../../application/prompter-state.ts";
import { captureOperation, stillOwns } from "../../legacy/transition-bridge.ts";
import { importHome } from "../../legacy/location-bridge.ts";
import { expandHiddenShotStrip } from "../../js/01b-hide-shot.js";
import {
  closeHistoryPanel,
  promptForName,
  promptForWpm,
  restoreSnapshotFromCard
} from "../../js/03-sync.js";
import { initSidePanelResizeHandles } from "../../js/03b-side-panels.js";
import { openGalleryOverlay } from "../../js/05e-gallery-overlay.js";
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
} from "../../js/11-import.js";
import { updateSaveStatus } from "../../js/12-dirty-toast.js";
import { showToast } from "../../legacy/effects-bridge.ts";
import { preferences } from "../../legacy/preferences-bridge.ts";
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
} from "../../js/13-hosted.js";
import { saveDoc } from "../../js/14-export.js";
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
} from "../../js/18-local-files.js";
import { cancelMergeReview, confirmFileMerge, openMergeReview } from "../../js/18a-local-merge.js";
import { toggleFileMenu, toggleSubmenu } from "../../js/18b-file-menu.js";
import { applyWriterSize, closeWriter, jumpFromWriterToRow } from "../../js/19-writer.js";
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
} from "../../js/20-teleprompter.js";
import {
  dismissDesktopAppNotice,
  dismissUpdateNotice,
  loadUpdateStatus,
  renderDesktopAppNotice
} from "../../js/20a-update.js";
import { routeServerOpen } from "../../js/20f-desktop.js";
import { finishMarkdownRowChoice } from "../../js/20d-formats.js";
import { onRootClick, routeRootClick } from "./editor.ts";

const viewMounts = new Map<string, Pick<Owned<Disposable>, "stop">>();

function replaceViewMount<T extends Disposable>(key: string, mount: () => T, routes?: (owner: T) => readonly (() => () => void)[]): T {
  let slot = viewMounts.get(key) as Owned<T> | undefined;
  if (!slot) {
    slot = owned<T>();
    viewMounts.set(key, slot);
  }
  return slot.replace(mount, routes);
}

export function stopViewFeature(key: string): void {
  const slot = viewMounts.get(key);
  if (slot) slot.stop();
}

function captureViewDocument(): () => boolean {
  const context = captureOperation();
  return function () { return stillOwns(context); };
}

export function mountAppearanceFeature(): ReturnType<typeof mountAppearance> {
  return replaceViewMount("mountAppearance", function () {
    const prefs = preferences();
    const ports: AppearancePorts = {
      theme: prefs.theme,
      tagIcons: prefs.tagIcons,
      nameOf: prefs.nameOf
    };
    return mountAppearance({ window: window, ports: ports });
  });
}

export function mountNoticesFeature(): ReturnType<typeof mountNotices> {
  return replaceViewMount("mountNotices", function () {
    const ports: NoticesPorts = {
      loadUpdateStatus: loadUpdateStatus,
      dismissUpdateNotice: dismissUpdateNotice,
      renderDesktopAppNotice: renderDesktopAppNotice,
      dismissDesktopAppNotice: dismissDesktopAppNotice
    };
    return mountNotices({ window: window, ports: ports });
  });
}

export function mountPrompterVisibilityFeature(): ReturnType<typeof mountPrompterVisibility> {
  return replaceViewMount("mountPrompterVisibility", function () {
    const ports: PrompterVisibilityPorts = {
      acquireWakeLock: function (active) {
        const ownsDocument = captureViewDocument();
        acquireWakeLock(function () { return active() && ownsDocument(); });
      },
      isOpen: prompterIsOpen
    };
    return mountPrompterVisibility({ window: window, ports: ports });
  });
}

export function mountIdentityFeature(): ReturnType<typeof mountIdentity> {
  return replaceViewMount("mountIdentity", function () {
    const ports: IdentityPorts = {
      promptForName: promptForName
    };
    return mountIdentity({ window: window, ports: ports });
  });
}

export function mountHistoryFeature(): ReturnType<typeof mountHistory> {
  return replaceViewMount("mountHistory", function () {
    const ports: HistoryPorts = {
      promptForWpm: promptForWpm,
      closeHistoryPanel: closeHistoryPanel,
      onRootClick: onRootClick
    };
    return mountHistory({ window: window, ports: ports });
  });
}

export function mountServerFeature(): ReturnType<typeof mountServer> {
  return replaceViewMount("mountServer", function () {
    const ports: ServerPorts = {
      closeServerPicker: closeServerPicker,
      openServerDoc: openServerDoc,
      armServerDelete: armServerDelete,
      routeOpen: routeServerOpen,
      capture: function () {
        const ownsDocument = captureViewDocument();
        const ownsModal = captureServerPicker();
        return function () { return ownsDocument() && ownsModal(); };
      }
    };
    return mountServer({ window: window, ports: ports });
  });
}

export function mountDriveFeature(): ReturnType<typeof mountDrive> {
  return replaceViewMount("mountDrive", function () {
    const ports: DrivePorts = {
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
    };
    return mountDrive({ window: window, ports: ports });
  });
}

export function mountSaveRecoveryFeature(): ReturnType<typeof mountSaveRecovery> {
  return replaceViewMount("mountSaveRecovery", function () {
    const ports: SaveRecoveryPorts = {
      hideResumeBanner: hideResumeBanner,
      resumeFromHandle: resumeFromHandle,
      showToast: showToast,
      saveDoc: saveDoc,
      exportAs: exportAs,
      pendingHandle: function () {
        const handle: ReturnType<SaveRecoveryPorts["pendingHandle"]> = pendingResumeHandle;
        return handle;
      },
      capture: captureViewDocument
    };
    return mountSaveRecovery({ window: window, ports: ports });
  });
}

export function mountConflictsFeature(): ReturnType<typeof mountConflicts> {
  return replaceViewMount("mountConflicts", function () {
    const ports: ConflictsPorts = {
      closeFileConflict: closeFileConflict,
      reloadProjectFromDisk: reloadProjectFromDisk,
      reloadFileFromDisk: reloadFileFromDisk,
      saveDoc: saveDoc,
      saveBackToFile: saveBackToFile,
      openMergeReview: openMergeReview,
      cancelMergeReview: cancelMergeReview,
      confirmFileMerge: confirmFileMerge,
      importHome: importHome as unknown as ConflictsPorts["importHome"],
      buildFileData: buildFileData,
      deliverFile: deliverFile,
      conflict: function () {
        const conflict: ReturnType<ConflictsPorts["conflict"]> = fileConflictCtx;
        return conflict;
      },
      capture: captureViewDocument
    };
    return mountConflicts({ window: window, ports: ports });
  });
}

export function mountPanelsFeature(): Disposable {
  return replaceViewMount("mountPanels", function () {
    return { dispose: initSidePanelResizeHandles() };
  });
}

export function mountSaveFeature(): ReturnType<typeof mountSave> {
  return replaceViewMount("mountSave", function () {
    const ports: SavePorts = {
      saveFromButton: saveFromButton,
      updateSaveStatus: updateSaveStatus
    };
    return mountSave({ window: window, ports: ports });
  });
}

export function mountPrompterOpenFeature(): ReturnType<typeof mountPrompterOpen> {
  return replaceViewMount("mountPrompterOpen", function () {
    const ports: PrompterOpenPorts = {
      runFromButton: runFromButton
    };
    return mountPrompterOpen({ window: window, ports: ports });
  });
}

export function mountFileMenuFeature(): ReturnType<typeof mountFileMenu> {
  return replaceViewMount("mountFileMenu", function () {
    const ports: FileMenuPorts = {
      toggleFileMenu: toggleFileMenu,
      toggleSubmenu: toggleSubmenu,
      handleFileMenuAction: handleFileMenuAction,
      openProjectFile: openProjectFile
    };
    return mountFileMenu({ window: window, ports: ports });
  });
}

export function mountImportsFeature(): ReturnType<typeof mountImports> {
  return replaceViewMount("mountImports", function () {
    const ports: ImportsPorts = {
      finishMarkdownRowChoice: finishMarkdownRowChoice,
      closeImportModal: closeImportModal,
      confirmImport: confirmImport,
      clearPendingFileRows: clearPendingFileRows,
      maybeAutoDetectTwoColumn: maybeAutoDetectTwoColumn,
      updateImportPreview: updateImportPreview,
      handleImportFile: handleImportFile,
      touchMode: touchImportMode,
      capture: function () {
        const ownsDocument = captureViewDocument();
        const ownsModal = captureImportPreview();
        return function () { return ownsDocument() && ownsModal(); };
      }
    };
    return mountImports({ window: window, ports: ports });
  });
}

export function mountGdocFeature(): ReturnType<typeof mountGdoc> {
  return replaceViewMount("mountGdoc", function () {
    const ports: GdocPorts = {
      closeGdocModal: closeGdocModal,
      confirmGdocImport: confirmGdocImport
    };
    return mountGdoc({ window: window, ports: ports });
  });
}

export function mountPrompterFeature(): ReturnType<typeof mountPrompter> {
  return replaceViewMount("mountPrompter", function () {
    const ports: PrompterPorts = {
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
      voiceActive: voiceIsFollowing,
      playing: prompterIsPlaying,
      isOpen: prompterIsOpen,
      skipShot: prompterSkipsShot,
      setSkipShot: setPrompterSkipShot,
      mirror: function () { const mirror: boolean = prompterMirror; return mirror; },
      flip: function () { const flip: boolean = prompterFlip; return flip; },
      sceneMode: function () { const sceneMode: boolean = promptSceneMode; return sceneMode; }
    };
    return mountPrompter({ window: window, ports: ports });
  });
}

export function mountWriterOpenFeature(): ReturnType<typeof mountWriterOpen> {
  return replaceViewMount("mountWriterOpen", function () {
    const ports: WriterOpenPorts = {
      runFromButton: runFromButton
    };
    return mountWriterOpen({ window: window, ports: ports });
  });
}

export function mountWriterNavigationFeature(): ReturnType<typeof mountWriterNavigation> {
  return replaceViewMount("mountWriterNavigation", function () {
    const ports: WriterNavigationPorts = {
      jumpFromWriterToRow: jumpFromWriterToRow,
      expandHiddenShotStrip: expandHiddenShotStrip,
      saveFromButton: saveFromButton,
      applyWriterSize: applyWriterSize
    };
    return mountWriterNavigation({ window: window, ports: ports });
  });
}

export function mountWriterCloseFeature(): ReturnType<typeof mountWriterClose> {
  return replaceViewMount("mountWriterClose", function () {
    const ports: WriterClosePorts = {
      closeWriter: closeWriter
    };
    return mountWriterClose({ window: window, ports: ports });
  });
}

export function mountHistoryGalleryFeature(): ReturnType<typeof mountHistoryGallery> {
  return replaceViewMount("mountHistoryGallery", function () {
    const ports: HistoryGalleryPorts = { restore: restoreSnapshotFromCard, open: openGalleryOverlay };
    return mountHistoryGallery(ports);
  }, function (owner) {
    return [
      function () { return routeRootClick("history-restore", function (e) { return owner.restoreClick(e); }); },
      function () { return routeRootClick("gallery", function (e) { return owner.galleryClick(e); }); }
    ];
  });
}
