export type ViewEvent = MouseEvent & KeyboardEvent & {
  readonly target: HTMLInputElement;
  readonly currentTarget: HTMLElement;
};

export function createViewLifetime(window: Window): {
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
        if (target !== window && target !== window.document && !(target as Node).isConnected) return;
        handler(event as ViewEvent);
      };
      target.addEventListener(type, listener, options);
      releases.push(() => target.removeEventListener(type, listener, options));
    },
    release: (dispose) => { releases.push(dispose); },
    dispose(): void {
      if (!active) return;
      active = false;
      releases.splice(0).reverse().forEach((release) => release());
    }
  };
}
