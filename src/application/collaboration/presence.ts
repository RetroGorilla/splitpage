export interface PresenceLocation {
  readonly view: "split" | "writer" | "present";
  readonly beat: string | null;
  readonly side: "audioText" | "visualText" | null;
}

export interface PresencePointId {
  readonly client: number;
  readonly clock: number;
}

export interface PresencePoint {
  readonly type: PresencePointId;
  readonly item: PresencePointId | null;
  readonly assoc: 0 | -1;
}

export interface PresenceCaret {
  readonly anchor: PresencePoint;
  readonly head: PresencePoint;
}

export interface PresenceProfile extends PresenceLocation {
  readonly name: string;
  readonly color: string;
  readonly caret: PresenceCaret | null;
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
  let binding: { send: (profile: PresenceProfile) => void } | undefined;
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
      binding?.send(next);
    },
    bind(send: (profile: PresenceProfile) => void) {
      const current = { send };
      binding = current;
      receive([]);
      if (binding === current && profile) send(profile);
      return {
        receive(next: readonly PresencePeer[]) {
          if (binding === current) receive(next);
        },
        dispose() {
          if (binding !== current) return;
          profile = undefined;
          binding = undefined;
          receive([]);
        }
      };
    }
  };
}
