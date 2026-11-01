import { historyOwner } from "./history.ts";
import type { ActionDefinition } from "../../application/actions.ts";
import { runMenuCommand } from "../../application/desktop/menu-commands.ts";
import { presence } from "./ports/desktop-presence.ts";
import { canOpenPrompterInBrowser, canOpenPrompterInChromium, desktopPort, restoreDesktop, useDesktopForTest } from "../../adapters/desktop/desktop-port.ts";
import type { DesktopPort } from "../../adapters/desktop/desktop-port.ts";
import { makeDesktopHandle } from "../../adapters/desktop/desktop-handle.ts";
import { makeDesktopBlobBackend, wireDesktopBlobs } from "../../adapters/desktop/desktop-blobs.js";
import { forgetDesktopVoice } from "../../adapters/desktop/desktop-voice.js";
import { makeFakeDesktopBackend } from "../../adapters/desktop/fake-desktop.ts";
import { exposeTestHook } from "../../features/common/test-hooks.ts";
import { desktopActions as definitions } from "../../features/desktop/actions.ts";
import { startDesktopView as mountDesktop } from "../../features/desktop/desktop.ts";
import type { DesktopMount, DesktopPorts } from "../../features/desktop/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentIdentity } from "./ports/document-identity-controls.ts";
import { awaitHandedDocument, handDesktopTo, handedDocumentSettled, legacyDesktopDocumentPorts, notifyDesktopDocumentState, startDesktopDocumentState } from "./desktop-owners.ts";
import { draftsTesting } from "./drafts.ts";
import { flushDraftNow } from "./recovery-owners.ts";
import { saveDoc } from "./save-owners.ts";
import { noteSessionEdit } from "./session-owner.ts";
import { openDocument } from "./transition-owners.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { place as portPlace } from "./ports/location.ts";
import { saves as portSaves } from "./ports/saving.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { startup as portStartup } from "./ports/startup.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;

const canOpenPrompter = { browser: canOpenPrompterInBrowser, chromium: canOpenPrompterInChromium };

const desktop = owned<DesktopMount>();

function desktopPorts(): DesktopPorts {
  return {
    running: presence.running,
    shell: desktopPort,
    canOpenPrompter: canOpenPrompter,
    makeHandle: (entry) => makeDesktopHandle(entry as Parameters<typeof makeDesktopHandle>[0]),
    wireBlobs: () => { wireDesktopBlobs(desktopPort()); },
    document: portDocument,
    place: portPlace,
    notices: portNotices,
    documents: { open: (opening) => openDocument(opening) },
    saves: { unsaved: portSaves.unsaved, save: () => saveDoc() },
    startup: portStartup,
    flushDraft: flushDraftNow,
    reassignDocId: (toId, message) => documentIdentity.reassignDocId(toId, message),
    documentState: { notify: notifyDesktopDocumentState, settled: handedDocumentSettled, awaitHanded: awaitHandedDocument },
    menuCommands: { run: runMenuCommand }
  };
}

function testHooks(mounted: DesktopMount) {
  return {
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
    get drafts() { return draftsTesting(); },
    markDirtyForTest: function () { noteSessionEdit(); }
  };
}

// why: exposeTestHook drops only the call, after tree shaking has kept what it names; folding this to null first
// lets a release build leave out the hook object and the fake backend it carries.
const desktopTestHooks = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ? testHooks : null;

export function mountDesktopFeature(): DesktopMount {
  return desktop.replace(() => {
    const stopState = startDesktopDocumentState(legacyDesktopDocumentPorts({ isPristineSeedDocument: () => historyOwner().isPristineSeedDocument() }));
    let mounted: DesktopMount;
    try {
      if (presence.running()) wireDesktopBlobs(desktopPort());
      mounted = mountDesktop(desktopPorts());
      handDesktopTo({ openPrompterInBrowser: mounted.openPrompterInBrowser });
      exposeTestHook("__desktopTest", () => desktopTestHooks?.(mounted), () => undefined);
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

export function desktopActions(): ActionDefinition[] {
  return definitions(desktop.owner, { screen: portScreen, running: presence.running, canOpenPrompter: canOpenPrompter });
}
