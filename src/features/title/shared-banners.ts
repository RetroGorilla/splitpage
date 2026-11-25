import { accessRemovedMessage } from "../../application/collaboration/state.ts";
import type { CollaborationLocalWriteError, CollaborationPermanentRefusal } from "../../application/collaboration/state.ts";
import { sharedSaveStatus } from "../../application/save/status.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { restoreDialogFocus } from "../common/dialog-focus.ts";
import type { SharedBannersMount, SharedBannersPorts } from "./ports.ts";

declare const SPLITPAGE_COLLAB_UI: boolean | undefined;

interface AnchoredBanner {
  readonly element: HTMLElement;
  readonly home: Text;
}

export function createSharedBanners(window: Window, ports: SharedBannersPorts): SharedBannersMount {
  const document = window.document;
  const life = createViewLifetime(window);
  const byId = (id: string): HTMLElement | null => document.getElementById(id);

  const saveErrorBanner = byId("save-error-banner");
  const accessBanner = byId("collab-access-banner");
  const sizeBanner = byId("collab-size-banner");
  const writerStatus = byId("writer-collab-status");
  let passwordButton: HTMLButtonElement | undefined;
  if (typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI && ports.reenterPassword && accessBanner) {
    passwordButton = document.createElement("button");
    passwordButton.type = "button";
    passwordButton.className = "btn";
    passwordButton.id = "collab-access-reenter-password";
    passwordButton.textContent = "Re-enter password";
    passwordButton.hidden = true;
    byId("collab-access-export")?.before(passwordButton);
    life.listen(passwordButton, "click", ports.reenterPassword);
  }

  const anchored: AnchoredBanner[] = [];
  function anchor(element: HTMLElement | null): boolean {
    if (!element?.parentNode || anchored.some(banner => banner.element === element)) return false;
    const home = document.createTextNode("");
    element.before(home);
    anchored.push({ element, home });
    return true;
  }
  for (const element of [saveErrorBanner, accessBanner, sizeBanner, byId("collab-offline-banner")]) anchor(element);

  let writerHost: HTMLElement | null = null;
  let lastActive = false;
  let lastWriterOpen = false;
  let lastError: CollaborationLocalWriteError | null = null;
  let lastRefusal: CollaborationPermanentRefusal | null = null;
  let lastMergeTooLarge: string | null = null;

  function setText(id: string, value: string): void {
    const el = byId(id);
    if (el && el.textContent !== value) el.textContent = value;
  }

  function restoreToRoot(): void {
    for (const { element, home } of anchored) {
      if (element.isConnected && home.isConnected && element.previousSibling !== home) home.after(element);
    }
    writerHost?.remove();
    writerHost = null;
  }

  function placeBanners(active: boolean): void {
    const writer = byId("writer");
    const writerOpen = active && !!writer && !writer.hidden;
    if (!writerOpen) {
      restoreToRoot();
      return;
    }
    if (!writerHost || !writerHost.isConnected || writerHost.parentElement !== writer) {
      writerHost?.remove();
      writerHost = document.createElement("div");
      writerHost.className = "writer-banners";
      writerHost.id = "writer-banners";
      const scroll = byId("writer-scroll");
      if (scroll && scroll.parentElement === writer) scroll.before(writerHost);
      else writer.append(writerHost);
    }
    for (const { element } of anchored) {
      if (element.parentElement !== writerHost) writerHost.append(element);
    }
  }

  function hideBanner(banner: HTMLElement | null): void {
    if (!banner || banner.hidden) return;
    const hadFocus = banner.contains(document.activeElement);
    banner.hidden = true;
    if (typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI && hadFocus) {
      restoreDialogFocus(document, lastWriterOpen ? writerStatus : byId("shared-pill"));
    }
  }

  function showSaveError(error: CollaborationLocalWriteError, reveal: boolean): void {
    if (!saveErrorBanner) return;
    setText("save-error-text", error.message);
    setText("save-error-code", error.code || "");
    if (reveal) saveErrorBanner.hidden = false;
  }

  function showAccessRemoved(refusal: CollaborationPermanentRefusal, reveal: boolean): void {
    if (!accessBanner) return;
    setText("collab-access-text", typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI && refusal === "password-changed"
      ? "The link password changed. Re-enter it to sync your work." : accessRemovedMessage(refusal));
    if (passwordButton) passwordButton.hidden = refusal !== "password-changed";
    if (reveal) accessBanner.hidden = false;
  }

  function showMergeTooLarge(message: string, reveal: boolean): void {
    if (!sizeBanner) return;
    setText("collab-size-text", message);
    if (reveal) sizeBanner.hidden = false;
  }

  function sync(): void {
    if (!life.active()) return;
    const snapshot = ports.collaboration.snapshot();
    if (!snapshot.active) {
      if (!lastActive) return;
      hideBanner(saveErrorBanner);
      hideBanner(accessBanner);
      hideBanner(sizeBanner);
      setText("save-error-text", "");
      setText("save-error-code", "");
      setText("collab-access-text", "");
      setText("collab-size-text", "");
      restoreToRoot();
      lastError = null;
      lastRefusal = null;
      lastMergeTooLarge = null;
      lastWriterOpen = false;
      lastActive = false;
      return;
    }

    const writer = byId("writer");
    const writerOpen = !!writer && !writer.hidden;
    const errorChanged = snapshot.localWriteError !== lastError;
    const sizeChanged = snapshot.mergeTooLarge !== lastMergeTooLarge;
    const refusalChanged = snapshot.refusal !== lastRefusal;
    const fileCopyAdded = typeof SPLITPAGE_COLLAB_UI !== "undefined" && SPLITPAGE_COLLAB_UI && anchor(byId("file-copy-banner"));
    if (lastActive && !errorChanged && !sizeChanged && !refusalChanged && !fileCopyAdded && writerOpen === lastWriterOpen) return;

    if (!lastActive || errorChanged) {
      if (snapshot.localWriteError) showSaveError(snapshot.localWriteError, errorChanged);
      else hideBanner(saveErrorBanner);
      lastError = snapshot.localWriteError;
    }

    if (!lastActive || sizeChanged) {
      if (snapshot.mergeTooLarge) showMergeTooLarge(snapshot.mergeTooLarge, sizeChanged);
      else hideBanner(sizeBanner);
      lastMergeTooLarge = snapshot.mergeTooLarge;
    }

    if (!lastActive || refusalChanged) {
      if (snapshot.refusal) showAccessRemoved(snapshot.refusal, refusalChanged);
      else hideBanner(accessBanner);
      lastRefusal = snapshot.refusal;
    }

    if (!lastActive || errorChanged || sizeChanged || refusalChanged || fileCopyAdded || writerOpen !== lastWriterOpen) {
      placeBanners(true);
      lastWriterOpen = writerOpen;
    }
    lastActive = true;
  }

  function openRecovery(): void {
    if (!life.active()) return;
    const snapshot = ports.collaboration.snapshot();
    if (!snapshot.active) return;
    const view = sharedSaveStatus(snapshot);
    if (view.banner === "save-error" && snapshot.localWriteError) {
      showSaveError(snapshot.localWriteError, true);
      placeBanners(true);
      byId("save-error-retry")?.focus({ preventScroll: true });
    } else if (view.banner === "merge-too-large" && snapshot.mergeTooLarge) {
      showMergeTooLarge(snapshot.mergeTooLarge, true);
      placeBanners(true);
      byId("collab-size-export")?.focus({ preventScroll: true });
    } else if (view.banner === "access-removed" && snapshot.refusal) {
      showAccessRemoved(snapshot.refusal, true);
      placeBanners(true);
      byId("collab-access-export")?.focus({ preventScroll: true });
    }
  }

  if (writerStatus) life.listen(writerStatus, "click", openRecovery);
  const accessExport = byId("collab-access-export");
  if (accessExport) life.listen(accessExport, "click", () => { ports.exportCopy(); });
  const accessLeave = byId("collab-access-leave");
  if (accessLeave) life.listen(accessLeave, "click", () => { ports.leave(); });
  const accessDismiss = byId("collab-access-dismiss");
  if (accessDismiss) life.listen(accessDismiss, "click", () => { hideBanner(accessBanner); });
  const sizeExport = byId("collab-size-export");
  if (sizeExport) life.listen(sizeExport, "click", () => { ports.exportCopy(); });
  const sizeLeave = byId("collab-size-leave");
  if (sizeLeave) life.listen(sizeLeave, "click", () => { ports.leave(); });
  const sizeDismiss = byId("collab-size-dismiss");
  if (sizeDismiss) life.listen(sizeDismiss, "click", () => { hideBanner(sizeBanner); });

  life.release(() => {
    passwordButton?.remove();
    hideBanner(accessBanner);
    hideBanner(sizeBanner);
    if (lastActive) hideBanner(saveErrorBanner);
    restoreToRoot();
    for (const { home } of anchored) home.remove();
  });

  sync();
  return { sync, openRecovery, dispose: life.dispose };
}
