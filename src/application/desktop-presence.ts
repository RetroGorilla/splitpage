export interface LaunchFacts {
  readonly firstTabOfLaunch: () => boolean | undefined;
  readonly hadPriorSession: () => boolean | undefined;
  readonly launchIntent: () => { readonly type: string } | undefined;
  readonly hasDraftToRestore: () => boolean | undefined;
  readonly appVersion: () => string | null | undefined;
}

export interface ExternalLinks {
  readonly available: () => boolean;
  readonly open: (url: string) => void;
}

export interface DesktopPresence {
  readonly running: () => boolean;
}
