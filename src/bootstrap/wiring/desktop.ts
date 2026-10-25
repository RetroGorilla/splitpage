import type { ActionDefinition } from "../../application/actions.ts";
import { runMenuCommand } from "../../application/desktop/menu-commands.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { canOpenPrompterInBrowser, canOpenPrompterInChromium, desktopPort, driveOpenShown, restoreDesktop, useDesktopForTest } from "../../adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../adapters/desktop/desktop-port.ts";
import { makeDesktopHandle } from "../../adapters/desktop/desktop-handle.ts";
import { makeDesktopBlobBackend, wireDesktopBlobs } from "../../adapters/desktop/desktop-blobs.js";
import { forgetDesktopVoice } from "../../adapters/desktop/desktop-voice.js";
import { makeFakeDesktopBackend } from "../../adapters/desktop/fake-desktop.js";
import { desktopActions as definitions } from "../../features/desktop/actions.ts";
import { __init as mountDesktop } from "../../features/desktop/desktop.js";
import type { DesktopMount, DesktopPorts } from "../../features/desktop/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { reassignDocId } from "../../js/02b-doc-id.js";
import { pointTabAt } from "../../js/13-hosted.js";
import { awaitHandedDocument, handDesktopTo, handedDocumentSettled, legacyDesktopDocumentPorts, notifyDesktopDocumentState, startDesktopDocumentState } from "../../legacy/desktop-bridge.ts";
import { checkServer, serverStatus, setHome } from "../../legacy/location-bridge.ts";
import { flushDraftNow } from "../../legacy/recovery-bridge.ts";
import { saveDoc } from "../../legacy/save-bridge.ts";
import { noteSessionEdit } from "../../legacy/session-bridge.ts";
import { openDocument } from "../../legacy/transition-bridge.ts";
import { actions as portActions } from "./ports/actions.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { place as portPlace } from "./ports/location.ts";
import { saves as portSaves } from "./ports/saving.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { startup as portStartup } from "./ports/startup.ts";

const canOpenPrompter = { browser: canOpenPrompterInBrowser, chromium: canOpenPrompterInChromium };

const desktop = owned<DesktopMount>();

function desktopPorts(): DesktopPorts {
  return {
    running: runningOnDesktop,
    shell: desktopPort,
    canOpenPrompter: canOpenPrompter,
    driveOpenShown: driveOpenShown,
    makeHandle: (entry) => makeDesktopHandle(entry as Parameters<typeof makeDesktopHandle>[0]),
    wireBlobs: () => { wireDesktopBlobs(desktopPort()); },
    document: portDocument,
    place: portPlace,
    server: {
      setHome: (kind) => { setHome(kind); },
      forgetMode: () => { serverStatus().forgetMode(); },
      check: () => { void checkServer(); },
      pointTabAt: (url, options) => { pointTabAt(url, options); }
    },
    notices: portNotices,
    documents: { open: (opening) => openDocument(opening) },
    saves: { unsaved: portSaves.unsaved, save: () => saveDoc() },
    startup: portStartup,
    actions: portActions,
    flushDraft: flushDraftNow,
    reassignDocId: (toId, message) => reassignDocId(toId, message),
    documentState: { notify: notifyDesktopDocumentState, settled: handedDocumentSettled, awaitHanded: awaitHandedDocument },
    menuCommands: { run: runMenuCommand }
  };
}

function installTestHooks(mounted: DesktopMount): void {
  const hooks = {
    makeHandle: makeDesktopHandle,
    runMenuCommand: mounted.runMenuCommand,
    makeFakeBackend: makeFakeDesktopBackend,
    makeBlobBackend: makeDesktopBlobBackend,
    initDesktop: mounted.initDesktop,
    setBackend: function (fake: Partial<DesktopPort> | null) {
      useDesktopForTest(fake);
      forgetDesktopVoice();
      if (fake && typeof fake.blobPut === "function") wireDesktopBlobs(fake);
      mounted.wireReassignDocId();
    },
    restoreBackend: function () {
      restoreDesktop();
      forgetDesktopVoice();
      wireDesktopBlobs(desktopPort());
    },
    get tabId() { const port = desktopPort(); return port && port.tabId; },
    markDirtyForTest: function () { noteSessionEdit(); }
  };
  Object.assign(window, { __desktopTest: hooks });
}

export function mountDesktopFeature(): DesktopMount {
  return desktop.replace(() => {
    const stopState = startDesktopDocumentState(legacyDesktopDocumentPorts());
    let mounted: DesktopMount;
    try {
      if (runningOnDesktop()) wireDesktopBlobs(desktopPort());
      mounted = mountDesktop(desktopPorts());
      handDesktopTo({ renderShareInfo: mounted.renderShareInfo, openPrompterInBrowser: mounted.openPrompterInBrowser });
      installTestHooks(mounted);
    } catch (error) {
      handDesktopTo(null);
      stopState();
      throw error;
    }
    return {
      ...mounted,
      dispose: () => {
        handDesktopTo(null);
        mounted.dispose();
        stopState();
      }
    };
  });
}

export const stopDesktopFeature = desktop.stop;

export function startDesktopShell(): void {
  desktop.owner()?.initDesktop();
}

export function routeServerOpen(id: string | null): Promise<boolean> | null {
  const mounted = desktop.owner();
  return mounted ? mounted.routeServerOpen(id) : null;
}

export function desktopActions(): ActionDefinition[] {
  return definitions(desktop.owner, { screen: portScreen, running: runningOnDesktop, canOpenPrompter: canOpenPrompter });
}
