import { createNativeShareSnapshot } from "../../adapters/collab/native/convert.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { createShareAttempt } from "../../application/collaboration/share.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import { mintDocId } from "../../adapters/identity/ids.ts";
import { joinScriptAction, leaveScriptAction, shareScriptAction, sharingDetailsAction, SHARING_COMMAND, JOIN_SCRIPT_COMMAND, LEAVE_SCRIPT_COMMAND, SHARE_SCRIPT_COMMAND } from "../../features/collaboration/actions.ts";
import { mountLeaveDialog } from "../../features/collaboration/leave.ts";
import { mountSharedPopover } from "../../features/collaboration/shared-popover.ts";
import { mountPasswordDialog } from "../../features/collaboration/password-dialog.ts";
import { collaboration } from "./ports/collaboration.ts";
import { mountShareDialog } from "../../features/collaboration/mount.ts";
import { scriptCellOf } from "../richtext.ts";
import { migrateRows } from "../document-ports.ts";
import { documentReader } from "./ports/document.ts";
import { fileDelivery } from "./ports/files.ts";
import { localFileMenuControls } from "./local-files.ts";
import { openDesktopJoin } from "./collaboration-join.ts";
import { relayOriginAllowed } from "./relay-address.ts";
import { retainedSharedScriptActive, retainedSharingControls } from "./retained-shared-script.ts";
import { screen } from "./ports/screen.ts";
import { getEditorName, preferences } from "./preferences-owner.ts";
import { changes } from "./ports/preferences.ts";
import { hashedPersonColor } from "../../core/document/person-colors.ts";
import { presenceName } from "../../../shared/collaboration-presence.ts";
import { mountPresenceView } from "../../features/collaboration/presence.ts";
import { sharedPresence } from "./ports/presence.ts";
import { mountPresenceCarets } from "../../features/collaboration/presence-carets.ts";
import { nativePresenceCarets } from "./shared-session.ts";
import { cssAttr } from "../../features/common/dom.ts";
import { writerControls } from "./writer.ts";
import { holdSessionCommands, liveSession, sessionEntryRefusal, sharedSession } from "./session-owner.ts";
import { enterCreatedSharedScript, sharedEntry } from "./shared-entry.ts";
import { captureOperation, stillOwns } from "./transition-owners.ts";
import { undoOwner } from "./undo.ts";
import { holdDesktopDocumentPublication } from "./desktop-owners.ts";
import { autoSavePolicy, saveBusy, scheduleAutoSave } from "./save-owners.ts";
import { mountFileCopyBanner } from "../../features/collaboration/file-copy-banner.ts";
import { sharedFileCopy } from "./shared-file-copy.ts";
import { announceCollaboration, mountCollaborationAnnouncements } from "../../features/collaboration/announcements.ts";

declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

const canJoin = () => !!desktopPort() && !sharedSession();

export const collaborationMenuItems = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? () => [
  { ...SHARE_SCRIPT_COMMAND, group: "Collaborate", available: () => !!desktopPort()?.shareScript && !sharedSession() },
  { ...JOIN_SCRIPT_COMMAND, group: "Collaborate", available: canJoin },
  { ...SHARING_COMMAND, group: "Collaborate", available: sharedSession },
  { ...LEAVE_SCRIPT_COMMAND, group: "Collaborate", available: sharedSession }
] : () => [];

let leaveDialog: ReturnType<typeof mountLeaveDialog> | undefined;

function openLeave() {
  if (!retainedSharedScriptActive()) return false;
  if (leaveDialog && !leaveDialog.signal.aborted) return true;
  const context = captureOperation();
  leaveDialog = mountLeaveDialog({
    owner: retainedSharingControls()?.role === "owner",
    async saveCopy() {
      if (!stillOwns(context)) return false;
      const files = localFileMenuControls();
      const file = await files.buildFileData("splitpage", files.exportBaseName());
      return fileDelivery.deliver(file.filename, file.data, { savedMsg: "Saved a separate copy" });
    },
    async leave() {
      if (!stillOwns(context)) return false;
      const result = await sharedEntry()?.leave();
      if (result?.ok) announceCollaboration(document, "Left the shared script.");
      return result?.ok ? true : result?.reason === "file-copy-cancelled" ? "cancelled" : false;
    }
  });
  return true;
}

export const requestRetainedLeave = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? openLeave : () => false;

let recoveryDialog: ReturnType<typeof mountPasswordDialog> | undefined;

function openPasswordRecovery(): void {
  if (recoveryDialog && !recoveryDialog.signal.aborted) return;
  const controls = retainedSharingControls();
  if (!controls) return;
  recoveryDialog = mountPasswordDialog({
    title: "Re-enter password", submit: "Reconnect",
    check: signal => controls.reenter(null, signal),
    save: controls.reenter
  });
}

export const requestPasswordRecovery = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI
  ? openPasswordRecovery : undefined;

function registerCollaboration(registry: Pick<ActionRegistry, "invoke" | "register">): () => void {
  const unmountAnnouncements = mountCollaborationAnnouncements(document, { collaboration });
  const unmountFileCopy = mountFileCopyBanner(sharedFileCopy);
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
              created: { state, membership: { token: created.owner, role: "owner", guestLinkToken: created.guest,
                ...(created.passwordRequired && { linkPasswordRequired: true }) }, complete }
            }, { owns, release });
          } finally { publish(); }
        }
      });
      dispose?.();
      dispose = mountShareDialog({
        address: () => owner.status().then(({ address }) => address && relayOriginAllowed(address) ? address : null),
        share: async (...args) => {
          if (!relayOriginAllowed(args[0])) return { kind: "not-configured" };
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
  const presence = sharedPresence();
  const stopPresence = mountPresenceView({
    collaboration, presence,
    identity() {
      const name = presenceName(getEditorName());
      return { name, color: preferences().myColor() || hashedPersonColor(name) };
    },
    onIdentityChange: listener => changes.onChange(({ name }) => {
      if (name === "commentAuthor" || name === "personColor") listener();
    }),
    setLocal: presence.setLocal,
    caret: (location, cell, ends) => nativePresenceCarets()?.caret(location, cell, ends) ?? null
  });
  const stopCarets = mountPresenceCarets({
    collaboration, presence,
    resolve: (peer, cell) => nativePresenceCarets()?.resolve(peer, cell) ?? null
  });
  const popover = mountSharedPopover({
    collaboration,
    presence,
    revealBeat(id, side) {
      registry.invoke("reveal-row", "button", id);
      const writer = writerControls()?.writerFlowControl();
      if (writer) {
        writer.caret(id, 0);
        return;
      }
      const row = document.querySelector('#rows .row[data-id="' + cssAttr(id) + '"]');
      row?.scrollIntoView({ block: "center" });
      row?.querySelector<HTMLElement>('.cell-editable[data-field="' + side + '"]')?.focus({ preventScroll: true });
    },
    membership: retainedSharingControls,
    canManage: () => retainedSharingControls()?.canManage() ?? Promise.resolve(false),
    async manage(operation, password) {
      const controls = retainedSharingControls();
      if (!controls) throw new Error("The shared script is unavailable.");
      await controls.manage(operation, password);
    },
    saveCopy: () => { registry.invoke("save-as", "button"); },
    copy: text => navigator.clipboard.writeText(text),
    async leave() {
      if (!openLeave() && !((await sharedEntry()?.leave())?.ok ?? false)) throw new Error("Could not leave the shared script.");
    },
    open: () => { registry.invoke(SHARING_COMMAND.id, "button"); },
    confirm: message => window.confirm(message)
  });
  const unregisterSharing = registry.register(sharingDetailsAction({ screen, visible: sharedSession, open: popover.open }));
  const unregisterJoin = registry.register(joinScriptAction({ screen, visible: canJoin, open: openDesktopJoin }));
  const unregisterLeave = registry.register(leaveScriptAction({ screen, visible: sharedSession, open: () => { if (!openLeave()) void sharedEntry()?.leave(); } }));
  return () => {
    unregisterLeave();
    unmountAnnouncements();
    unmountFileCopy();
    unregisterSharing();
    popover.dispose();
    stopPresence();
    stopCarets();
    unregisterJoin();
    unregister();
    leaveDialog?.dispose();
    leaveDialog = undefined;
    recoveryDialog?.dispose();
    recoveryDialog = undefined;
    dispose?.();
  };
}

export const registerCollaborationActions = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? registerCollaboration : () => () => {};
