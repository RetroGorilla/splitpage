import type { EffectPorts, Notice, NoticeKind } from "../application/effects/ports.ts";

let started: EffectPorts<Element> | null = null;
let stopped = false;

function running(): EffectPorts<Element> {
  if (!started) throw new Error("The notice, menu-item and clipboard ports are not started yet");
  return started;
}

export function startEffects(ports: EffectPorts<Element>): () => void {
  if (started) throw new Error("The notice, menu-item and clipboard ports are already started; stop them first");
  started = ports;
  stopped = false;
  return function () {
    if (started !== ports) return;
    started = null;
    stopped = true;
  };
}

export function effectsStarted(): boolean {
  return started !== null;
}

export function showToast(message: string, kind?: NoticeKind, sticky?: boolean): Notice {
  return running().notices.show(message, kind, sticky);
}

export function showActionToast(message: string, kind: NoticeKind | undefined, label: string, onAction: () => void, sticky?: boolean): Notice {
  return running().notices.showAction(message, kind, label, onAction, sticky);
}

export function setMenuItemLabel(item: Element | null | undefined, text: string): void {
  if (stopped && !started) return;
  running().menuItems.setLabel(item, text);
}

export function setMenuItemReason(item: Element | null | undefined, reason: string): void {
  if (stopped && !started) return;
  running().menuItems.setReason(item, reason);
}

export function copyShareText(text: string): Promise<boolean> {
  return running().clipboard.copyText(text);
}
