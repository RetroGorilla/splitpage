export interface ServerResume {
  readonly id: string;
  readonly rev: number;
  readonly base: unknown;
  readonly mine: unknown;
  readonly at: number;
  readonly onDone: (outcome: string) => void;
}

export interface DraftResume {
  readonly serverResume: () => ServerResume | null;
  readonly armServerResume: (resume: ServerResume) => void;
  readonly dropServerResume: () => void;
  readonly restorePending: () => boolean;
  readonly setRestorePending: (pending: boolean) => void;
}

export function createDraftResume(): DraftResume {
  let server: ServerResume | null = null;
  let pending = false;
  return Object.freeze({
    serverResume: function (): ServerResume | null { return server; },
    armServerResume: function (resume: ServerResume): void {
      if (!resume || typeof resume.onDone !== "function") throw new Error("armServerResume: a server resume needs its onDone function");
      server = resume;
    },
    dropServerResume: function (): void { server = null; },
    restorePending: function (): boolean { return pending; },
    setRestorePending: function (value: boolean): void { pending = !!value; }
  });
}
