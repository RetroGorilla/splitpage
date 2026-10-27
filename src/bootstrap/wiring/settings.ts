import { updateControls } from "./update.ts";
import type { ActionDefinition } from "../../application/actions.ts";
import { setCommentSort } from "../../application/comment-sort.ts";
import { appDataActions as appDataDefinitions } from "../../features/settings/actions.ts";
import { mountAppData } from "../../features/settings/app-data.js";
import type { AppDataMount, AppDataPorts } from "../../features/settings/ports.ts";
import { historyOwner } from "./history.ts";
import { connectPortOr, newBookmarkId, renderConnect, saveBookmarks } from "../../js/20e-connect.js";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { setBackend as setBlobBackend } from "../../adapters/storage/02c-blobs.js";
import { appDataPreferences } from "./ports/preferences.ts";
import { bookmarks } from "./ports/location.ts";
import { fileDelivery } from "./ports/files.ts";
import { launch } from "./ports/desktop.ts";
import { screen } from "./ports/screen.ts";
import { installSettingsControls } from "../../application/settings-actions.ts";
import { actions as portActions } from "./ports/actions.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { changes as portChanges } from "./ports/preferences.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { startSettings as mountSettings } from "../../features/settings/settings.js";
import type { SettingsMount, SettingsPorts } from "../../features/settings/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { setHideShotScenes } from "./hide-shot.ts";
import { personSwatchesHtml } from "../../js/03-sync.js";
import { getSavedAuthorName } from "../../application/comment-author.js";
import { DEFAULT_COLLAB_SERVER, collabServerView, normalizeCollabServer, readCollabServer, signOutCollab } from "../../js/13b-collaborate.js";
import { connectWriter } from "./writer.ts";
import { prompterControls } from "./prompter.ts";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { setAutoSaveEnabled } from "../../legacy/save-bridge.ts";

function inactiveWriterSize(): void {}
function writerSizePreference(): number | null { return preferences().writerSize(); }

const settings = owned<SettingsMount>();

export function mountSettingsFeature(): SettingsMount {
  return settings.replace(() => {
    const editor: { -readonly [K in keyof SettingsPorts["editor"]]: SettingsPorts["editor"][K] } = {
      writerSize: writerSizePreference, setWriterSize: inactiveWriterSize, hideShot: setHideShotScenes, autoSave: setAutoSaveEnabled
    };
    const ports: SettingsPorts = {
      actions: portActions,
      notices: portNotices,
      changes: portChanges,
      elsewhere: (listener) => {
        const onStorage = (event: StorageEvent): void => {
          if (event.key && event.key.indexOf("splitpage-") === 0) listener(preferences().nameOf(event.key));
        };
        window.addEventListener("storage", onStorage);
        return () => { window.removeEventListener("storage", onStorage); };
      },
      preferences: {
        announceTaggingHelp: () => preferences().announceTaggingHelp(),
        autosave: () => preferences().autosave(),
        clock: () => preferences().clock(),
        commentAuthor: () => preferences().commentAuthor(),
        defaultWpm: () => preferences().defaultWpm(),
        hideShot: () => preferences().hideShot(),
        prompterFlag: (value) => preferences().prompterFlag(value),
        resetDesktopNotice: () => preferences().resetDesktopNotice(),
        resetTour: () => preferences().resetTour(),
        rundownMin: () => preferences().rundownMin(),
        scriptScale: () => preferences().scriptScale(),
        setClock: (value) => preferences().setClock(value),
        setCollabServer: (value) => preferences().setCollabServer(value),
        setCommentAuthor: (value) => preferences().setCommentAuthor(value),
        setDefaultWpm: (value) => preferences().setDefaultWpm(value),
        setMyColor: (value) => preferences().setMyColor(value),
        setRundownMin: (value) => preferences().setRundownMin(value),
        setScriptScale: (value) => preferences().setScriptScale(value),
        setTagIcons: (value) => preferences().setTagIcons(value),
        setTheme: (value) => preferences().setTheme(value),
        setVideoThumbs: (value) => preferences().setVideoThumbs(value),
        tagIcons: () => preferences().tagIcons(),
        theme: () => preferences().theme(),
        videoThumbs: () => preferences().videoThumbs(),
      },
      editor,
      identity: { name: () => getSavedAuthorName(preferences()), swatchesHtml: personSwatchesHtml },
      prompter: { mirror: (value) => { prompterControls()?.setPrompterMirror(value); }, flip: (value) => { prompterControls()?.setPrompterFlip(value); }, sceneMode: (value) => { prompterControls()?.setPrompterSceneMode(value); } },
      collaboration: {
        defaultServer: DEFAULT_COLLAB_SERVER, view: collabServerView, normalize: normalizeCollabServer,
        address: readCollabServer, signOut: signOutCollab
      },
      desktop: { running: runningOnDesktop, renderNotice: () => { updateControls()?.renderDesktopAppNotice(); } }
    };
    const mounted: SettingsMount = mountSettings(ports);
    const disconnect = connectWriter((control) => {
      editor.writerSize = control?.readWriterSize ?? writerSizePreference;
      editor.setWriterSize = control?.applyWriterSize ?? inactiveWriterSize;
    });
    const uninstall = installSettingsControls(mounted);
    return {
      openSettings: mounted.openSettings,
      dispose: () => {
        disconnect();
        uninstall();
        mounted.dispose();
      }
    };
  });
}

export const stopSettingsFeature = settings.stop;


const appData = owned<AppDataMount>();

export function mountAppDataFeature(): AppDataMount {
  return appData.replace(() => {
    const writer: { -readonly [K in keyof AppDataPorts["writer"]]: AppDataPorts["writer"][K] } = { size: writerSizePreference, setSize: inactiveWriterSize };
    const ports: AppDataPorts = {
      notices: portNotices,
      fileDelivery,
      preferences: appDataPreferences,
      desktop: runningOnDesktop,
      launchFacts: launch,
      bookmarks,
      commentSorting: { choose: setCommentSort },
      history: { exportAll: () => historyOwner().exportHistoryAll(), importBundle: (bundle) => historyOwner().importHistoryBundle(bundle), normalizeSnapshots: (raw) => historyOwner().normalizeLegacySnapshots(raw) },
      writer,
      embeddedVersion: () => updateControls()?.readEmbeddedVersion() ?? null,
      bookmarkEditor: { newId: newBookmarkId, portOr: connectPortOr, save: saveBookmarks, render: renderConnect },
      useBlobBackend: setBlobBackend
    };
    const mounted = mountAppData(ports);
    const disconnect = connectWriter((control) => {
      writer.size = control?.readWriterSize ?? writerSizePreference;
      writer.setSize = control?.applyWriterSize ?? inactiveWriterSize;
    });
    return { ...mounted, dispose: () => { disconnect(); mounted.dispose(); } };
  });
}

export const stopAppDataFeature = appData.stop;

export function appDataActions(): ActionDefinition[] {
  return appDataDefinitions(appData.owner, { screen, importShown: () => !!desktopPort() });
}
