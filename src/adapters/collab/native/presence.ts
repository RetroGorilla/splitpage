import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { PresenceCaret, PresencePeer, PresencePoint, PresencePointId, PresenceProfile } from "../../../application/collaboration/presence.ts";
import { paletteColor } from "../../../core/document/person-colors.ts";
import { PRESENCE_FIELD, presenceName } from "../../../../shared/collaboration-presence.ts";

const SEND_INTERVAL_MS = 200;

function samePoint(a: PresencePoint, b: PresencePoint): boolean {
  return a.assoc === b.assoc && a.type.client === b.type.client && a.type.clock === b.type.clock &&
    (a.item === b.item || (!!a.item && !!b.item && a.item.client === b.item.client && a.item.clock === b.item.clock));
}

function sameCaret(a: PresenceCaret | null, b: PresenceCaret | null): boolean {
  return a === b || (!!a && !!b && samePoint(a.anchor, b.anchor) && samePoint(a.head, b.head));
}

function sameProfile(a: PresenceProfile, b: PresenceProfile | undefined): boolean {
  return a.name === b?.name && a.color === b.color && a.view === b.view && a.beat === b.beat && a.side === b.side &&
    sameCaret(a.caret, b.caret);
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (keys && (own.length !== keys.length || keys.some(key => !own.includes(key)))) return null;
  return value as Record<string, unknown>;
}

const wholeNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function pointId(value: unknown): PresencePointId | null {
  const id = record(value, ["client", "clock"]);
  return id && wholeNumber(id.client) && wholeNumber(id.clock) ? { client: id.client, clock: id.clock } : null;
}

// why: a peer's position is untrusted; a named root here would make Yjs create that root in our document on resolve
function point(value: unknown): PresencePoint | null {
  const fields = record(value, ["type", "item", "assoc"]);
  if (!fields || (fields.assoc !== 0 && fields.assoc !== -1)) return null;
  const type = pointId(fields.type), item = fields.item === null ? null : pointId(fields.item);
  if (!type || (fields.item !== null && !item)) return null;
  return { type, item, assoc: fields.assoc };
}

function caretOf(value: unknown): PresenceCaret | null | undefined {
  if (value === null || value === undefined) return null;
  const fields = record(value, ["anchor", "head"]);
  const anchor = fields && point(fields.anchor), head = fields && point(fields.head);
  return anchor && head ? { anchor, head } : undefined;
}

function printable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function parse(value: unknown): PresenceProfile | null {
  const fields = record(value);
  if (!fields) return null;
  const { name: rawName, color, view, beat, side } = fields;
  const name = presenceName(rawName);
  const safeColor = paletteColor(color);
  if (!name || name !== rawName || !safeColor) return null;
  if (view !== "split" && view !== "writer" && view !== "present") return null;
  if (!(beat === null && side === null) &&
      !(typeof beat === "string" && beat.length > 0 && beat.length <= 256 && printable(beat) &&
        (side === "audioText" || side === "visualText"))) return null;
  const caret = caretOf(fields.caret);
  if (caret === undefined || (caret && beat === null)) return null;
  return { name, color: safeColor, view, beat: beat as string | null, side: side as PresenceProfile["side"], caret };
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
      const profile = parse(state[PRESENCE_FIELD]);
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
      provider.setAwarenessField(PRESENCE_FIELD, pending);
    }, SEND_INTERVAL_MS);
  };
}
