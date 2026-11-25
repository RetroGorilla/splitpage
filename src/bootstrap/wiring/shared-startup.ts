import { stopNativeCaretWait } from "./native-switch-caret.ts";
import { stopCollaborationOwner } from "./collaboration-owner.ts";
import { startDesktopSharedResume } from "./desktop-shared-resume.ts";
import { mountSharedEntry, sharedEntry } from "./shared-entry.ts";
import { startSharedTestHook } from "./shared-test.ts";
import { startInvitationEntry } from "./collaboration-join.ts";
import { startSharedReopen } from "./shared-reopen.ts";
import { holdDesktopDocumentPublication } from "./desktop-owners.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;
declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

const startInvitations = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? startInvitationEntry : undefined;
const startReopen = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI ? startSharedReopen : undefined;
let stopEntry: (() => void) | undefined;

function mount(): void {
  stopSharedSessionFeature();
  const test = startSharedTestHook?.(() => invitations?.status() ?? { connected: false, settled: false });
  const stop = mountSharedEntry(() => test?.left());
  const stopResume = startDesktopSharedResume(async entry => {
    const publish = holdDesktopDocumentPublication();
    try { return (await sharedEntry()?.enter(entry, entry.signal)) ?? { ok: false, reason: "app-stopped" }; }
    finally { publish(); }
  });
  const invitations = startInvitations?.();
  const stopReopen = startReopen?.(invitations?.hasInvitation ?? false);
  stopEntry = () => {
    stopReopen?.();
    stopResume();
    invitations?.dispose();
    try { stop(); } finally { test?.dispose(); }
  };
}

const mountEnabled = typeof SPLITPAGE_TEST_HOOKS === "undefined" || SPLITPAGE_TEST_HOOKS ||
  (typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI) ? mount : undefined;

export function mountSharedSessionFeature(): void {
  mountEnabled?.();
}

export function stopSharedSessionFeature(): void {
  const stop = stopEntry;
  stopEntry = undefined;
  stopNativeCaretWait();
  try { stop?.(); } finally { stopCollaborationOwner(); }
}
