export interface DesktopDraftPorts<Draft> {
  readonly taker: (() => PromiseLike<Draft>) | null;
  readonly detectServer: () => void;
  readonly armServerResume: (draft: Draft | null) => void;
  readonly applyDraft: (draft: Draft | null) => unknown;
}

export interface DesktopDraft {
  readonly resume: (current: () => boolean) => PromiseLike<unknown> | undefined;
}

export function takeDesktopDraft<Draft>(ports: DesktopDraftPorts<Draft>): DesktopDraft {
  const taker = ports.taker;
  if (!taker) {
    ports.detectServer();
    return { resume: () => undefined };
  }
  const taken: Promise<Draft | null> = Promise.resolve().then(() => taker()).catch(() => null);
  return {
    resume: (current) => taken.then((draft) => {
      if (!current()) return undefined;
      ports.armServerResume(draft);
      ports.detectServer();
      return ports.applyDraft(draft);
    })
  };
}
