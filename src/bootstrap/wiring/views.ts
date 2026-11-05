import { updateControls } from "./update.ts";
import type { Disposable, Owned } from "../../features/routing/owned.ts";
import type { NoticesPorts } from "../../features/notices/mount.ts";
import type { PrompterVisibilityPorts, PrompterOpenPorts, PrompterPorts } from "../../features/prompter/mount.ts";
import type { IdentityPorts } from "../../features/settings/mount.ts";
import type { AppearancePorts } from "../../features/settings/appearance.ts";
import type { HistoryPorts } from "../../features/history/mount.ts";
import type { SaveRecoveryPorts, ConflictsPorts, SavePorts, FileMenuPorts } from "../../features/file-menu/mount.ts";
import type { ImportsPorts, GdocPorts } from "../../features/imports/mount.ts";
import type { WriterOpenPorts, WriterNavigationPorts } from "../../features/writer/mount.ts";
import type { HistoryGalleryPorts } from "../../features/gallery/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { runFromButton, saveFromButton } from "./ports/actions.ts";
import { mountNotices } from "../../features/notices/mount.ts";
import { mountPrompterVisibility, mountPrompterOpen, mountPrompter } from "../../features/prompter/mount.ts";
import { mountIdentity } from "../../features/settings/mount.ts";
import { mountAppearance } from "../../features/settings/appearance.ts";
import { mountHistory } from "../../features/history/mount.ts";
import { mountSaveRecovery, mountConflicts, mountSave, mountFileMenu } from "../../features/file-menu/mount.ts";
import { mountImports, mountGdoc } from "../../features/imports/mount.ts";
import { mountWriterOpen, mountWriterNavigation, mountWriterClose } from "../../features/writer/mount.ts";
import { mountHistoryGallery } from "../../features/gallery/mount.ts";
import { mountTopbar } from "../../features/title/topbar.ts";
import { mountCellReach } from "../../features/editing/cell-reach.ts";
import { mountPhoneBar } from "../../features/notices/phone-bar.ts";
import { importMode, prompterState } from "./ports/preferences.ts";
import { captureOperation, openDocument, stillOwns } from "./transition-owners.ts";
import { importHome } from "./location-owner.ts";
import { expandHiddenShotStrip } from "./hide-shot.ts";
import { promptForName, promptForWpm } from "./title-chrome.ts";
import { restoreSnapshotFromCard } from "./history-panel.ts";
import { openGalleryOverlay } from "../../features/gallery/overlay.ts";
import { thumbnailsOnBeatClick } from "./gallery.ts";
import { importControls } from "./imports.ts";
import { updateSaveStatus } from "./save-status.ts";
import { showToast } from "./effects-owner.ts";
import { panelWidths, preferences } from "./preferences-owner.ts";
import { sidePanels } from "./ports/panels.ts";
import { SIDE_PANEL_IDS } from "../../application/preferences/panel-widths.ts";
import { mountPanels } from "../../features/panels/mount.ts";
import { fileConflicts, saveDoc } from "./save-owners.ts";
import { fileDelivery } from "./ports/files.ts";
import { localFileMenuControls, localFilesOwner } from "./local-files.ts";
import { currentMergeReview } from "./merge-review.ts";
import { toggleFileMenu, toggleSubmenu } from "./file-menu-controls.ts";
import { connectWriter } from "./writer.ts";
import { prompterControls } from "./prompter.ts";
import { finishMarkdownRowChoice } from "./project-files.ts";
import { onRootClick, routeRootClick } from "./editor.ts";

function inactiveWriterNavigation(): void {}

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

let topbar: ReturnType<typeof mountTopbar> | null = null;

export function refreshWriterChrome(): void {
  topbar?.refreshWriterChrome();
}

export function mountTopbarFeature(): Disposable {
  return replaceViewMount("mountTopbar", function () {
    const mounted = mountTopbar({ window: window });
    topbar = mounted;
    return { dispose: () => {
      if (topbar === mounted) topbar = null;
      mounted.dispose();
    } };
  });
}

export function mountCellReachFeature(): Disposable {
  return replaceViewMount("mountCellReach", function () {
    return mountCellReach({ window: window });
  });
}

export function mountPhoneBarFeature(): Disposable {
  return replaceViewMount("mountPhoneBar", function () {
    return mountPhoneBar({ window: window });
  });
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
      loadUpdateStatus: () => updateControls()?.loadUpdateStatus() ?? (() => {}),
      dismissUpdateNotice: () => { updateControls()?.dismissUpdateNotice(); },
      renderDesktopAppNotice: () => updateControls()?.renderDesktopAppNotice() ?? (() => {}),
      dismissDesktopAppNotice: () => { updateControls()?.dismissDesktopAppNotice(); }
    };
    return mountNotices({ window: window, ports: ports });
  });
}

export function mountPrompterVisibilityFeature(): ReturnType<typeof mountPrompterVisibility> {
  return replaceViewMount("mountPrompterVisibility", function () {
    const ports: PrompterVisibilityPorts = {
      acquireWakeLock: function (active) {
        const ownsDocument = captureViewDocument();
        prompterControls()?.acquireWakeLock(function () { return active() && ownsDocument(); });
      },
      isOpen: prompterState.isOpen
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
      closeHistoryPanel: () => { sidePanels().close("history-panel"); },
      onRootClick: onRootClick
    };
    return mountHistory({ window: window, ports: ports });
  });
}

export function mountSaveRecoveryFeature(): ReturnType<typeof mountSaveRecovery> {
  return replaceViewMount("mountSaveRecovery", function () {
    const ports: SaveRecoveryPorts = {
      hideResumeBanner: (...args: Parameters<ReturnType<typeof localFileMenuControls>["hideResumeBanner"]>) => localFileMenuControls().hideResumeBanner(...args),
      resumeFromHandle: (...args: Parameters<ReturnType<typeof localFilesOwner>["resumeFromHandle"]>) => localFilesOwner().resumeFromHandle(...args),
      showToast: showToast,
      saveDoc: saveDoc,
      exportAs: (...args: Parameters<ReturnType<typeof localFileMenuControls>["exportAs"]>) => localFileMenuControls().exportAs(...args),
      pendingHandle: function () {
        const handle: ReturnType<SaveRecoveryPorts["pendingHandle"]> = localFileMenuControls().pendingHandle();
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
      closeFileConflict: function () { fileConflicts().close(); },
      reloadProjectFromDisk: (...args: Parameters<ReturnType<typeof localFilesOwner>["reloadProjectFromDisk"]>) => localFilesOwner().reloadProjectFromDisk(...args),
      reloadFileFromDisk: (...args: Parameters<ReturnType<typeof localFilesOwner>["reloadFileFromDisk"]>) => localFilesOwner().reloadFileFromDisk(...args),
      saveDoc: saveDoc,
      openMergeReview: function () { currentMergeReview()?.open(); },
      cancelMergeReview: function () { currentMergeReview()?.cancel(); },
      confirmFileMerge: function () { currentMergeReview()?.confirm(); },
      importHome: importHome as unknown as ConflictsPorts["importHome"],
      buildFileData: (...args: Parameters<ReturnType<typeof localFileMenuControls>["buildFileData"]>) => localFileMenuControls().buildFileData(...args),
      deliverFile: fileDelivery.deliver,
      conflict: function () { return fileConflicts().current(); },
      capture: captureViewDocument
    };
    return mountConflicts({ window: window, ports: ports });
  }, function () {
    return [function () { return fileConflicts().onChange(function () { localFileMenuControls().showFileConflictView(fileConflicts().current()); }); }];
  });
}

export function mountPanelsFeature(): Disposable {
  return replaceViewMount("mountPanels", function () {
    return mountPanels({ window: window, ports: {
      ids: SIDE_PANEL_IDS,
      readWidth: (id) => panelWidths().read(id),
      defaultWidth: (id) => panelWidths().defaultWidth(id),
      clampWidth: (width, id) => panelWidths().clamp(width, id),
      applyWidth: (id, width) => { sidePanels().applyWidth(id, width); },
      saveWidth: (id, width) => { panelWidths().save(id, width); }
    } });
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
      handleFileMenuAction: (...args: Parameters<ReturnType<typeof localFileMenuControls>["handleFileMenuAction"]>) => localFileMenuControls().handleFileMenuAction(...args),
      openProjectFile: function (file, handle) { void openDocument({ kind: "file", file: file, handle: handle }); }
    };
    return mountFileMenu({ window: window, ports: ports });
  });
}

export function mountImportsFeature(): ReturnType<typeof mountImports> {
  return replaceViewMount("mountImports", function () {
    const ports: ImportsPorts = {
      finishMarkdownRowChoice: finishMarkdownRowChoice,
      closeImportModal: () => { importControls()?.closeImportModal(); },
      confirmImport: () => { importControls()?.confirmImport(); },
      clearPendingFileRows: () => { importControls()?.clearPendingFileRows(); },
      maybeAutoDetectTwoColumn: (value) => { importControls()?.maybeAutoDetectTwoColumn(value); },
      updateImportPreview: () => { importControls()?.updateImportPreview(); },
      handleImportFile: function (file) { void openDocument({ kind: "import", file: file }); },
      touchMode: importMode.touch,
      capture: function () {
        const ownsDocument = captureViewDocument();
        const ownsModal = importControls()?.captureImportPreview() ?? (() => false);
        return function () { return ownsDocument() && ownsModal(); };
      }
    };
    return mountImports({ window: window, ports: ports });
  });
}

export function mountGdocFeature(): ReturnType<typeof mountGdoc> {
  return replaceViewMount("mountGdoc", function () {
    const ports: GdocPorts = {
      closeGdocModal: () => { importControls()?.closeGdocModal(); },
      confirmGdocImport: () => { importControls()?.confirmGdocImport(); }
    };
    return mountGdoc({ window: window, ports: ports });
  });
}

export function mountPrompterFeature(): ReturnType<typeof mountPrompter> {
  return replaceViewMount("mountPrompter", function () {
    const ports: PrompterPorts = {
      disposeRuntime: () => { prompterControls()?.disposeRuntime(); },
      closePrompter: () => { prompterControls()?.closePrompter(); },
      closeFind: () => prompterControls()?.closeFind() ?? false,
      stopVoiceFollow: () => { prompterControls()?.stopVoiceFollow(); },
      startVoiceFollow: () => { prompterControls()?.startVoiceFollow(); },
      applyPrompterSize: () => { prompterControls()?.applyPrompterSize(); },
      updatePrompterStatus: () => { prompterControls()?.updatePrompterStatus(); },
      buildPrompterContent: () => { prompterControls()?.buildPrompterContent(); },
      updateVoiceAvailability: () => { prompterControls()?.updateVoiceAvailability(); },
      cueBeatForCurrentPosition: () => { prompterControls()?.cueBeatForCurrentPosition(); },
      updateBeatReadout: () => { prompterControls()?.updateBeatReadout(); },
      setPrompterPlaying: (value) => { prompterControls()?.setPrompterPlaying(value); },
      setPrompterSpeed: (value) => { prompterControls()?.setPrompterSpeed(value); },
      stepPrompterSpeed: (value) => { prompterControls()?.stepPrompterSpeed(value); },
      stepPrompterSize: (value) => { prompterControls()?.stepPrompterSize(value); },
      setPrompterMirror: (value) => { prompterControls()?.setPrompterMirror(value); },
      setPrompterFlip: (value) => { prompterControls()?.setPrompterFlip(value); },
      setPrompterBeatMode: (value) => { prompterControls()?.setPrompterBeatMode(value); },
      stepBeat: (value) => { prompterControls()?.stepBeat(value); },
      voiceActive: prompterState.voiceFollowing, playing: prompterState.isPlaying, isOpen: prompterState.isOpen,
      skipShot: prompterState.skipsShot, setSkipShot: prompterState.setSkipShot,
      mirror: () => prompterControls()?.mirror() ?? false,
      flip: () => prompterControls()?.flip() ?? false,
      beatMode: () => prompterControls()?.beatMode() ?? false
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
    const ports: { -readonly [K in keyof WriterNavigationPorts]: WriterNavigationPorts[K] } = {
      jumpFromWriterToRow: inactiveWriterNavigation,
      expandHiddenShotStrip: expandHiddenShotStrip,
      saveFromButton: saveFromButton,
      applyWriterSize: inactiveWriterNavigation
    };
    const mounted = mountWriterNavigation({ window: window, ports: ports });
    const disconnect = connectWriter((control) => {
      ports.jumpFromWriterToRow = control?.jumpFromWriterToRow ?? inactiveWriterNavigation;
      ports.applyWriterSize = control?.applyWriterSize ?? inactiveWriterNavigation;
    });
    return { dispose: () => { disconnect(); mounted.dispose(); } };
  });
}

export function mountWriterCloseFeature(): ReturnType<typeof mountWriterClose> {
  return replaceViewMount("mountWriterClose", function () {
    const ports = {
      closeWriter: inactiveWriterNavigation
    };
    const mounted = mountWriterClose({ window: window, ports: ports });
    const disconnect = connectWriter((control) => { ports.closeWriter = control?.closeWriter ?? inactiveWriterNavigation; });
    return { dispose: () => { disconnect(); mounted.dispose(); } };
  });
}

export function mountHistoryGalleryFeature(): ReturnType<typeof mountHistoryGallery> {
  return replaceViewMount("mountHistoryGallery", function () {
    const ports: HistoryGalleryPorts = { restore: restoreSnapshotFromCard, open: openGalleryOverlay, beatClicked: thumbnailsOnBeatClick };
    return mountHistoryGallery(ports);
  }, function (owner) {
    return [
      function () { return routeRootClick("history-restore", function (e) { return owner.restoreClick(e); }); },
      function () { return routeRootClick("gallery", function (e) { return owner.galleryClick(e); }); }
    ];
  });
}
