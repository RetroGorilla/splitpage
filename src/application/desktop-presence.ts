export interface ExternalLinks {
  readonly available: () => boolean;
  readonly open: (url: string) => void;
}

let present = false;

export const runningOnDesktop = (): boolean => present;
export const setRunningOnDesktop = (value: boolean): void => { present = value; };
