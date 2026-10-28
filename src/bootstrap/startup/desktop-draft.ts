export interface DesktopDraftPorts<Draft> {
  readonly taker: (() => PromiseLike<Draft>) | null;
  readonly applyDraft: (draft: Draft | null) => unknown;
}

export interface DesktopDraft {
  readonly resume: (current: () => boolean) => PromiseLike<unknown> | undefined;
}

export function takeDesktopDraft<Draft>(ports: DesktopDraftPorts<Draft>): DesktopDraft {
  const taker = ports.taker;
  if (!taker) return { resume: () => undefined };
  const taken: Promise<Draft | null> = Promise.resolve().then(() => taker()).catch(() => null);
  return {
    resume: (current) => taken.then((draft) => {
      if (!current()) return undefined;
      return ports.applyDraft(draft);
    })
  };
}
