import { InvitationSnapshotError, readInvitationSnapshot } from "../../adapters/collab/native/invitation-snapshot.ts";
import { exchangeLinkPassword } from "../../adapters/collab/native/password-exchange.ts";
import { openNativeSession } from "../../adapters/collab/native/session.ts";
import { startupReady } from "../../application/startup-signal.ts";
import { mountJoinDialog } from "../../features/collaboration/join.ts";
import type { JoinRequest, JoinDialogPorts } from "../../features/collaboration/ports.ts";
import { sanitizeHtml } from "../richtext.ts";
import { waitDuringLifetime } from "../startup/page-lifetime.ts";
import { newTabControls } from "./newtab.ts";
import { chromePreferences } from "./ports/preferences.ts";
import { getEditorName } from "./preferences-owner.ts";
import { sharedEntry } from "./shared-entry.ts";
import { captureDocumentOpeningLifetime } from "./transition-owners.ts";
import { holdDesktopDocumentPublication } from "./desktop-owners.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { focusDesktopSharedScript } from "../../adapters/collab/native/desktop-local-store.ts";

declare const SPLITPAGE_TEST_HOOKS: boolean | undefined;
declare let splitpageInvitation: { readonly script: string; readonly token: string } | false | null;

const SCRIPT_ID = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/;
const INVITATION = /^[A-Za-z0-9_-]{43}(?![\s\S])/;

export function invitationOriginAllowed(address: string): boolean {
  return address.startsWith("https://") || (typeof SPLITPAGE_TEST_HOOKS !== "undefined" && SPLITPAGE_TEST_HOOKS
    && /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(address));
}

function readLink(request: JoinRequest): { script: string; token: string; origin: string } | null {
  try {
    const url = new URL(request.kind === "paste" ? request.link.trim() : location.origin);
    if (url.username || url.password || !invitationOriginAllowed(url.origin)) return null;
    if (request.kind === "browser") return request.invitation ? { ...request.invitation, origin: url.origin } : null;
    const [script, extra] = url.searchParams.getAll("join");
    const token = url.hash.slice(1);
    return script && extra === undefined && SCRIPT_ID.test(script) && INVITATION.test(token)
      ? { script, token, origin: url.origin } : null;
  } catch { return null; }
}

function openJoinScreen(request: Extract<JoinRequest, { kind: "browser" }> | undefined, connected: (value: boolean) => void,
  settled: () => void) {
  const ports: JoinDialogPorts = {
    identity: chromePreferences,
    editor: getEditorName,
    async check(link, lifetime, password) {
      const invitation = readLink(link);
      if (!invitation) return { kind: "failed", reason: "bad-link" };
      const { origin, script, token } = invitation;
      let openingSignal: AbortSignal | undefined;
      try {
        const ready = startupReady();
        if (!ready) return { kind: "failed", reason: "opening-pending" };
        await waitDuringLifetime(ready, lifetime);
        const opening = captureDocumentOpeningLifetime();
        openingSignal = opening.signal;
        const signal = AbortSignal.any([lifetime, opening.signal]);
        await waitDuringLifetime(opening.settled, signal);
        const deploymentPath = link.kind === "paste" ? "/api/deployment" : "/index.html";
        const response = await fetch(new URL(deploymentPath, origin), {
          method: "HEAD", cache: "no-store", redirect: "error", credentials: "omit",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        });
        const deployment = response.headers.get("Splitpage-Deployment");
        if (!response.ok || !deployment || !SCRIPT_ID.test(deployment)) return { kind: "failed", reason: "relay-unreachable" };
        const desktop = desktopPort();
        if (desktop && await focusDesktopSharedScript(desktop.nativeReplica, deployment, script)) return { kind: "focused" };
        const endpoint = new URL("/", origin);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const relayUrl = endpoint.href;
        const exchange = password === undefined ? null : await exchangeLinkPassword(origin, script, token, password, signal);
        if (exchange?.kind === "failed") return exchange;
        const credential = exchange?.token ?? token;
        const state = await readInvitationSnapshot(relayUrl, script, credential, signal);
        const preview = openNativeSession({ kind: "stored-script", state }, { actor: getEditorName(), sanitize: sanitizeHtml });
        try {
          if (!preview.isStoredScript()) return { kind: "failed", reason: "invalid-script" };
          const { title, rows } = preview.document();
          return {
            kind: "ready", title, beats: rows.length, pictures: preview.pictureReferences().required.length,
            async join(cancel, progress) {
              const opening = captureDocumentOpeningLifetime();
              const joining = AbortSignal.any([opening.signal, cancel]);
              try { await waitDuringLifetime(opening.settled, joining); }
              catch { return "opening-pending"; }
              const publish = holdDesktopDocumentPublication();
              try {
                const outcome = await sharedEntry()?.enter({
                  deployment, script, relayUrl, invitation: { token: credential, ...(credential !== token && { guestLinkToken: token }), state },
                  onRelayConnected: connected, onPictureProgress: progress
                }, joining);
                if (!outcome?.ok) return outcome?.reason ?? "opening-pending";
                newTabControls()?.closeNewTabPage();
                return null;
              } finally { publish(); }
            }
          };
        } finally { preview.close(); }
      } catch (error) {
        if (lifetime.aborted) return { kind: "failed", reason: "cancelled" };
        if (openingSignal?.aborted) return { kind: "failed", reason: "opening-pending" };
        if (error instanceof InvitationSnapshotError) return { kind: "failed", reason: error.reason };
        return { kind: "failed", reason: "relay-unreachable" };
      }
    },
    settled
  };
  return mountJoinDialog(ports, request);
}

let desktopDialog: ReturnType<typeof openJoinScreen> | undefined;

export function openDesktopJoin(): void {
  if (desktopDialog && !desktopDialog.signal.aborted) return;
  desktopDialog = openJoinScreen(undefined, () => {}, () => {});
}

export function startInvitationEntry() {
  let connected = false, settled = false;
  const invitation = typeof splitpageInvitation !== "undefined" ? splitpageInvitation : null;
  if (typeof splitpageInvitation !== "undefined") splitpageInvitation = null;
  const browserDialog = invitation === null ? undefined : openJoinScreen({ kind: "browser", invitation },
    value => { connected = value; }, () => { settled = true; });
  return {
    hasInvitation: invitation !== null,
    status: () => ({ connected, settled }),
    dispose() {
      browserDialog?.dispose();
      desktopDialog?.dispose();
      desktopDialog = undefined;
    }
  };
}
