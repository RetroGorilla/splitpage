interface LocalStartupFixturePorts {
  desktop: boolean;
  draft: { taker: (() => Promise<string>) | null; applyDraft: (draft: string | null) => void };
  document: {
    pristine: () => boolean;
    load: () => Promise<{ id: string }>;
    clone: (loaded: { id: string }) => { id: string };
    applyStash: (loaded: { id: string }) => { state: { id: string } };
    liveDocument: () => { id: string };
    open: (document: { id: string }, reason: string) => void;
    firstDraw: () => void;
    refreshChrome: (() => void)[];
    reportRecovery: () => void;
    toastLastEditor: () => void;
    resumeLastProject: () => void;
    syncIdentity: () => void;
    openIdentityChannel: () => void;
    notifyDesktop: () => void;
    startHistoryMigration: () => void;
  };
  page: { window: Window; snapshotKey: string; unsaved: () => boolean };
  startDesktop: () => void;
}

declare const LocalStartupUnderTest: {
  beginStartup: (ports: LocalStartupFixturePorts) => { openDocument: () => Promise<unknown>; finish: () => void; dispose: () => void };
};

export async function probeLocalStartup(desktop: boolean): Promise<{ events: string[]; final: string }> {
  const events: string[] = [];
  let live = { id: "before" };
  let release: (document: { id: string }) => void = () => { throw new Error("Missing hydrate gate"); };
  const loaded = new Promise<{ id: string }>(resolve => { release = resolve; });
  let deliverOpenFile: () => void = () => { throw new Error("Desktop not mounted"); };
  const open = (document: { id: string }, reason: string): void => { live = document; events.push(`open:${document.id}:${reason}`); };
  const startup = LocalStartupUnderTest.beginStartup({
    desktop,
    draft: { taker: desktop ? () => { events.push("draft-take"); return Promise.resolve("draft"); } : null,
      applyDraft: draft => { events.push("applyTakenDraft"); if (draft) open({ id: draft }, "fixture draft application"); } },
    document: {
      pristine: () => false, load: () => { events.push("hydrate-start"); return loaded; }, clone: doc => ({ ...doc }),
      applyStash: doc => ({ state: doc }), liveDocument: () => live, open,
      firstDraw: () => { events.push("firstDraw"); }, refreshChrome: [], reportRecovery: () => undefined, toastLastEditor: () => undefined,
      resumeLastProject: () => { events.push("resumeLastProject"); open({ id: "last-project" }, "fixture resumed project"); },
      syncIdentity: () => { events.push("syncIdentity"); }, openIdentityChannel: () => undefined, notifyDesktop: () => undefined,
      startHistoryMigration: () => { events.push("history-migration"); }
    },
    page: { window, snapshotKey: "local-startup-fixture", unsaved: () => false },
    startDesktop: () => { events.push("desktop-mount"); deliverOpenFile = () => open({ id: "file" }, "fixture open-file delivery"); }
  });
  try {
    const ready = startup.openDocument();
    startup.finish();
    await Promise.resolve();
    if (desktop) deliverOpenFile();
    events.push("hydrate-release");
    release({ id: "replica" });
    await ready;
    return { events, final: live.id };
  } finally { startup.dispose(); }
}
