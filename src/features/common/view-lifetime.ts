import { addListener } from "./listeners.ts";

type ViewEvent = MouseEvent & KeyboardEvent & PointerEvent & InputEvent & ClipboardEvent & WheelEvent & {
  readonly target: HTMLInputElement & { readonly files?: FileList };
  readonly currentTarget: HTMLElement;
};

export function createViewLifetime(window: Window, guard: (target: EventTarget) => boolean = (target) =>
  target === window || target === window.document || !!(target as Node).isConnected): {
  active: () => boolean;
  listen: (target: EventTarget | null, type: string, handler: (event: ViewEvent) => void, options?: boolean | AddEventListenerOptions) => void;
  release: (dispose: () => void) => void;
  dispose: () => void;
} {
  let active = true;
  const releases: (() => void)[] = [];
  return {
    active: () => active,
    listen(target, type, handler, options = false): void {
      if (!target) return;
      const listener: EventListener = (event) => {
        if (!active) return;
        if (!guard(target)) return;
        handler(event as ViewEvent);
      };
      releases.push(addListener(target, type, listener, options));
    },
    release: (dispose) => { releases.push(dispose); },
    dispose(): void {
      if (!active) return;
      active = false;
      releases.splice(0).reverse().forEach((release) => release());
    }
  };
}
