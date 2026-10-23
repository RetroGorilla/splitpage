export interface LaunchFacts {
  readonly firstTabOfLaunch: () => boolean | undefined;
  readonly hadPriorSession: () => boolean | undefined;
  readonly launchIntent: () => { readonly type: string } | undefined;
  readonly hasDraftToRestore: () => boolean | undefined;
  readonly appVersion: () => string | undefined;
  readonly sessionInfo: () => Promise<{ readonly hosting?: boolean; readonly [key: string]: unknown } | null> | undefined;
}

export interface ExternalLinks {
  readonly available: () => boolean;
  readonly open: (url: string) => void;
}

let present = false;

export const runningOnDesktop = (): boolean => present;
export const setRunningOnDesktop = (value: boolean): void => { present = value; };
