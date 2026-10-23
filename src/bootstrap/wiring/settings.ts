import { installSettingsControls } from "../../application/settings-actions.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { __init as mountSettings } from "../../features/settings/settings.js";
import type { SettingsMount, SettingsPorts } from "../../features/settings/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { setHideShotScenes } from "../../js/01b-hide-shot.js";
import { personSwatchesHtml } from "../../js/03-sync.js";
import { getSavedAuthorName } from "../../js/10-comments.js";
import { DEFAULT_COLLAB_SERVER, collabServerView, normalizeCollabServer, readCollabServer, signOutCollab } from "../../js/13b-collaborate.js";
import { applyWriterSize, readWriterSize } from "../../js/19-writer.js";
import { setPrompterFlip, setPrompterMirror, setPrompterSceneMode } from "../../js/20-teleprompter.js";
import { renderDesktopAppNotice } from "../../js/20a-update.js";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { setAutoSaveEnabled } from "../../legacy/save-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const settings = owned<SettingsMount>();

export function mountSettingsFeature(): SettingsMount {
  return settings.replace(() => {
    const shared = sharedPorts();
    const ports: SettingsPorts = {
      actions: shared.actions,
      notices: shared.notices,
      changes: shared.changes,
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
      editor: { writerSize: readWriterSize, setWriterSize: applyWriterSize, hideShot: setHideShotScenes, autoSave: setAutoSaveEnabled },
      identity: { name: getSavedAuthorName, swatchesHtml: personSwatchesHtml },
      prompter: { mirror: setPrompterMirror, flip: setPrompterFlip, sceneMode: setPrompterSceneMode },
      collaboration: {
        defaultServer: DEFAULT_COLLAB_SERVER, view: collabServerView, normalize: normalizeCollabServer,
        address: readCollabServer, signOut: signOutCollab
      },
      desktop: { running: runningOnDesktop, renderNotice: renderDesktopAppNotice }
    };
    const mounted: SettingsMount = mountSettings(ports);
    const uninstall = installSettingsControls(mounted);
    return {
      openSettings: mounted.openSettings,
      dispose: () => {
        uninstall();
        mounted.dispose();
      }
    };
  });
}

export const stopSettingsFeature = settings.stop;

