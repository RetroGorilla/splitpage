export interface StartupSignal {
  readonly ready: () => Promise<unknown> | null;
}

let connected: StartupSignal | null = null;

export function connectStartup(signal: StartupSignal): () => void {
  if (connected) throw new Error("A startup is already connected; disconnect it first");
  connected = signal;
  return function () {
    if (connected === signal) connected = null;
  };
}

export function startupReady(): Promise<unknown> | null {
  return connected ? connected.ready() : null;
}
