export interface LaunchFacts {
  readonly firstTabOfLaunch: () => boolean;
  readonly hadPriorSession: () => boolean;
  readonly launchIntent: () => { readonly type: string } | null;
  readonly hasDraftToRestore: () => boolean;
}

let present = false;

export const runningOnDesktop = (): boolean => present;
export const setRunningOnDesktop = (value: boolean): void => { present = value; };
