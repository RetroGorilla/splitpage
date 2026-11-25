import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { PresencePeer, PresenceProfile } from "../../../application/collaboration/presence.ts";
import { paletteColor, PERSON_NAME_MAX } from "../../../core/document/person-colors.ts";

const FIELD = "splitpagePresence";
const SEND_INTERVAL_MS = 200;

function sameProfile(a: PresenceProfile, b: PresenceProfile | undefined): boolean {
  return a.name === b?.name && a.color === b.color && a.view === b.view && a.beat === b.beat && a.side === b.side;
}

function parse(value: unknown): PresenceProfile | null {
  if (!value || typeof value !== "object") return null;
  const { name, color, view, beat, side } = value as Record<string, unknown>;
  const safeColor = paletteColor(color);
  if (typeof name !== "string" || !name.trim() || name.length > PERSON_NAME_MAX || !safeColor) return null;
  if (view !== "split" && view !== "writer" && view !== "present") return null;
  if (!(beat === null && side === null) &&
      !(typeof beat === "string" && beat.length > 0 && beat.length <= 256 &&
        (side === "audioText" || side === "visualText"))) return null;
  return { name, color: safeColor, view, beat: beat as string | null, side: side as PresenceProfile["side"] };
}

export function bindNativePresence(provider: HocuspocusProvider, receive: (peers: readonly PresencePeer[]) => void) {
  const awareness = provider.awareness;
  let pending: PresenceProfile | undefined;
  let last: PresenceProfile | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function changed({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void {
    if (![...added, ...updated, ...removed].some(id => id !== awareness?.clientID)) return;
    const peers: PresencePeer[] = [];
    for (const [clientId, state] of awareness?.getStates() ?? []) {
      if (clientId === awareness?.clientID) continue;
      const profile = parse(state[FIELD]);
      if (profile) peers.push({ clientId, ...profile });
    }
    peers.sort((a, b) => a.clientId - b.clientId);
    receive(peers);
  }

  awareness?.on("change", changed);
  provider.on("destroy", () => {
    clearTimeout(timer);
    awareness?.off("change", changed);
    receive([]);
  });

  return (profile: PresenceProfile): void => {
    if (sameProfile(profile, pending)) return;
    pending = profile;
    timer ??= setTimeout(() => {
      timer = undefined;
      if (!pending || sameProfile(pending, last)) return;
      last = pending;
      provider.setAwarenessField(FIELD, pending);
    }, SEND_INTERVAL_MS);
  };
}
