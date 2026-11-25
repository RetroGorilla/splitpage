import { createNativeShareSnapshot } from "../../adapters/collab/native/convert.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { createShareAttempt } from "../../application/collaboration/share.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import { mintDocId } from "../../adapters/identity/ids.ts";
import { joinScriptAction, leaveScriptAction, shareScriptAction, JOIN_SCRIPT_COMMAND, LEAVE_SCRIPT_COMMAND, SHARE_SCRIPT_COMMAND } from "../../features/collaboration/actions.ts";
import { mountLeaveDialog } from "../../features/collaboration/leave.ts";
import { mountShareDialog } from "../../features/collaboration/mount.ts";
import { scriptCellOf } from "../richtext.ts";
import { migrateRows } from "../document-ports.ts";
import { documentReader } from "./ports/document.ts";
import { fileDelivery } from "./ports/files.ts";
import { localFileMenuControls } from "./local-files.ts";
import { openDesktopJoin, invitationOriginAllowed } from "./collaboration-join.ts";
import { retainedSharedScriptActive } from "./retained-shared-script.ts";
import { screen } from "./ports/screen.ts";
import { getEditorName } from "./preferences-owner.ts";
import { holdSessionCommands, liveSession, sessionEntryRefusal, sharedSession } from "./session-owner.ts";
import { enterCreatedSharedScript, sharedEntry } from "./shared-entry.ts";
import { captureOperation, stillOwns } from "./transition-owners.ts";
import { undoOwner } from "./undo.ts";
import { holdDesktopDocumentPublication } from "./desktop-owners.ts";
import { autoSavePolicy, saveBusy, scheduleAutoSave } from "./save-owners.ts";

declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

const canJoin = () => !!desktopPort() && !sharedSession();

export const collaborationMenuItems = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? () => [
  { ...SHARE_SCRIPT_COMMAND, group: "Collaborate", available: () => !!desktopPort()?.shareScript && !sharedSession() },
  { ...JOIN_SCRIPT_COMMAND, group: "Collaborate", available: canJoin },
  { ...LEAVE_SCRIPT_COMMAND, group: "Collaborate", available: retainedSharedScriptActive }
] : () => [];

let leaveDialog: ReturnType<typeof mountLeaveDialog> | undefined;

function openLeave() {
  if (!retainedSharedScriptActive()) return false;
  if (leaveDialog && !leaveDialog.signal.aborted) return true;
  const context = captureOperation();
  leaveDialog = mountLeaveDialog({
    async saveCopy() {
      if (!stillOwns(context)) return false;
      const files = localFileMenuControls();
      const file = await files.buildFileData("splitpage", files.exportBaseName());
      return fileDelivery.deliver(file.filename, file.data, { savedMsg: "Saved a separate copy" });
    },
    async leave() { return stillOwns(context) && ((await sharedEntry()?.leave())?.ok ?? false); }
  });
  return true;
}

export const requestRetainedLeave = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? openLeave : () => false;

function registerCollaboration(registry: Pick<ActionRegistry, "invoke" | "register">): () => void {
  let attempt: ReturnType<typeof createShareAttempt> | undefined;
  let dispose: (() => void) | undefined;
  const unregister = registry.register(shareScriptAction({
    screen,
    visible: () => !!desktopPort()?.shareScript && !sharedSession(),
    open() {
      const desktop = desktopPort();
      const owner = desktop?.relayOwner;
      if (!desktop?.shareScript || !owner) return;
      const workflow = attempt ??= createShareAttempt({
        relay: desktop.shareScript,
        operations: { capture: captureOperation, stillOwns },
        generation: () => liveSession().generation(),
        current: documentReader.current,
        hold: () => {
          if (sessionEntryRefusal() || sharedSession() || saveBusy()) throw new Error("The script is already switching or saving.");
          undoOwner().flush();
          return holdSessionCommands("sharing-script");
        },
        snapshot(source) {
          const docId = mintDocId();
          return createNativeShareSnapshot(migrateRows({ ...source, docId }), {
            cells: scriptCellOf, creation: docId, at: new Date().toISOString(), by: getEditorName()
          });
        },
        async hash(bytes) {
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
          return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
        },
        newId: () => crypto.randomUUID(),
        link(created) {
          const link = new URL("/", created.address);
          link.searchParams.set("join", created.scriptId);
          link.hash = created.guest;
          return link.href;
        },
        async enter(created, state, owns, release, complete) {
          const endpoint = new URL("/", created.address);
          endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
          const publish = holdDesktopDocumentPublication();
          try {
            return await enterCreatedSharedScript({
              deployment: created.deployment,
              script: created.scriptId,
              relayUrl: endpoint.href,
              created: { state, membership: { token: created.owner, role: "owner", guestLinkToken: created.guest }, complete }
            }, { owns, release });
          } finally { publish(); }
        }
      });
      dispose?.();
      dispose = mountShareDialog({
        address: () => owner.status().then(({ address }) => address && invitationOriginAllowed(address) ? address : null),
        share: async (...args) => {
          if (!invitationOriginAllowed(args[0])) return { kind: "not-configured" };
          const autosave = autoSavePolicy();
          const pending = autosave.pending();
          const reason = "Sharing script…";
          const paused = !autosave.halted() && autosave.enabled();
          if (paused) autosave.halt(reason);
          try { return await workflow.share(...args); }
          finally {
            if (paused && autosave.halted() === reason) {
              autosave.resume();
              if (pending) scheduleAutoSave();
            }
          }
        },
        copy: text => navigator.clipboard.writeText(text),
        settings: () => { registry.invoke("settings", "button", { focus: "settings-relay-setup" }); }
      });
    }
  }));
  const unregisterJoin = registry.register(joinScriptAction({ screen, visible: canJoin, open: openDesktopJoin }));
  const unregisterLeave = registry.register(leaveScriptAction({ screen, visible: retainedSharedScriptActive, open: openLeave }));
  return () => {
    unregisterLeave();
    unregisterJoin();
    unregister();
    leaveDialog?.dispose();
    leaveDialog = undefined;
    dispose?.();
  };
}

export const registerCollaborationActions = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? registerCollaboration : () => () => {};
