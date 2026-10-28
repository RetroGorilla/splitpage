export interface DesktopDocumentState {
  readonly title: string;
  readonly dirty: boolean;
  readonly pristine: boolean;
  readonly docId: string | null;
  readonly fileId: string | null;
}

export interface DesktopDocumentFacts {
  readonly running: () => boolean;
  readonly document: () => { readonly title?: string; readonly docId?: string | null } | null;
  readonly restoring: () => boolean;
  readonly unsaved: () => boolean;
  readonly pristine: () => boolean;
  readonly fileId: () => string | null;
}

export interface DesktopDocumentStatePorts {
  readonly facts: DesktopDocumentFacts;
  readonly publish: (state: DesktopDocumentState) => void;
}

export interface DesktopDocumentListeners {
  readonly session: () => void;
  readonly location: () => void;
  readonly save: (change: string) => void;
}

export interface DesktopDocumentStateOwner {
  readonly notify: () => void;
  readonly settled: () => void;
  readonly awaitHanded: (intent: string | undefined) => void;
  readonly listeners: () => DesktopDocumentListeners;
  readonly dispose: () => void;
}

export function createDesktopDocumentState(ports: DesktopDocumentStatePorts): DesktopDocumentStateOwner {
  const facts = ports.facts;
  let awaitingHandedDocument = false;
  let lastDesktopDocumentState = "";

  function current(): DesktopDocumentState | null {
    if (!facts.running() || !facts.document() || awaitingHandedDocument) return null;
    const restoring = facts.restoring();
    const doc = facts.document();
    return {
      title: doc?.title || "Untitled Script",
      dirty: facts.unsaved() || restoring,
      pristine: facts.pristine() && !restoring,
      docId: doc?.docId || null,
      fileId: facts.fileId()
    };
  }

  function notify(): void {
    const state = current();
    if (!state) return;
    lastDesktopDocumentState = JSON.stringify(state);
    ports.publish(state);
  }

  function changed(): void {
    const state = current();
    if (state && JSON.stringify(state) !== lastDesktopDocumentState) notify();
  }

  return {
    notify,
    settled: () => {
      if (!awaitingHandedDocument) return;
      awaitingHandedDocument = false;
      notify();
    },
    awaitHanded: (intent) => {
      awaitingHandedDocument = intent === "open-file";
    },
    listeners: () => ({
      session: changed,
      location: changed,
      save: (change) => {
        if (change === "change") notify();
        else changed();
      }
    }),
    dispose: () => {
      awaitingHandedDocument = false;
      lastDesktopDocumentState = "";
    }
  };
}
