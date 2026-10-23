export interface StartupSignal {
  readonly ready: () => Promise<unknown> | null;
}
