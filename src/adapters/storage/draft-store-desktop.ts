import type { DesktopDraftStore } from "../../application/recovery/ports.ts";
import type { DesktopPort } from "../desktop/desktop-port.ts";

export type DesktopDraftBridge = Partial<Pick<DesktopPort, "writeDraft" | "discardDraft" | "takeDraft" | "draftRestoreDone" | "hasDraftToRestore">>;

type DesktopDraftTaking = Pick<DesktopPort, "takeDraft">;

export interface DesktopDraftStorePorts {
  readonly bridge: () => DesktopDraftBridge | null | undefined;
}

export function createDesktopDraftStore(ports: DesktopDraftStorePorts): DesktopDraftStore {
  function bridge(): DesktopDraftBridge {
    const b = ports.bridge();
    if (!b) throw new Error("desktop drafts: this page has no desktop bridge");
    return b;
  }

  return Object.freeze({
    writable: function () {
      const b = ports.bridge();
      return !!b && typeof b.writeDraft === "function";
    },
    canDiscard: function () {
      const b = ports.bridge();
      return !!b && typeof b.discardDraft === "function";
    },
    write: function (payload: unknown) {
      const b = bridge();
      if (typeof b.writeDraft !== "function") throw new Error("desktop drafts: the bridge cannot write a draft");
      return b.writeDraft(payload);
    },
    discard: function (seq: number) {
      const b = bridge();
      if (typeof b.discardDraft !== "function") throw new Error("desktop drafts: the bridge cannot discard a draft");
      return b.discardDraft(seq);
    },
    taker: function () {
      const desktop = ports.bridge();
      if (!(desktop && typeof desktop.takeDraft === "function")) return null;
      return function () { return (desktop as DesktopDraftTaking).takeDraft(); };
    },
    restoreDone: function (outcome: string) {
      const b = ports.bridge();
      if (b && typeof b.draftRestoreDone === "function") b.draftRestoreDone(outcome);
    },
    hasDraftToRestore: function () {
      const b = ports.bridge();
      return !!(b && b.hasDraftToRestore);
    }
  });
}
