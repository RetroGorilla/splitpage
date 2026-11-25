export interface PresenceLocation {
  readonly view: "split" | "writer" | "present";
  readonly beat: string | null;
  readonly side: "audioText" | "visualText" | null;
}

export interface PresenceProfile extends PresenceLocation {
  readonly name: string;
  readonly color: string;
}

export interface PresencePeer extends PresenceProfile {
  readonly clientId: number;
}

export interface PresenceReads {
  readonly peers: () => readonly PresencePeer[];
  readonly onChange: (listener: () => void) => () => void;
}

export function createPresenceState() {
  let peers: readonly PresencePeer[] = [];
  let profile: PresenceProfile | undefined;
  let publish: ((profile: PresenceProfile) => void) | undefined;
  const listeners = new Set<() => void>();

  function receive(next: readonly PresencePeer[]): void {
    if (!next.length && !peers.length) return;
    peers = next;
    for (const listener of listeners) {
      try { listener(); } catch { continue; }
    }
  }

  return {
    peers: () => peers,
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setLocal(next: PresenceProfile) {
      profile = next;
      publish?.(next);
    },
    bind(send: (profile: PresenceProfile) => void) {
      publish = send;
      receive([]);
      if (profile) send(profile);
      return {
        receive(next: readonly PresencePeer[]) {
          if (publish === send) receive(next);
        },
        dispose() {
          if (publish !== send) return;
          profile = undefined;
          publish = undefined;
          receive([]);
        }
      };
    }
  };
}
