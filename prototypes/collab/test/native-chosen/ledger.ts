export type LetterField = "audio" | "visual" | "name";

// why: what one recorded command did, as the person saw it; the ledger is updated only from these records
export interface LedgerEvent {
  index: number;
  by: number;
  op: string;
  seen: ReadonlySet<number>;
  typed: { char: string; field: LetterField; owner: string }[];
  erased: string[];
  deletedBeats: string[];
  seenVisual: string[];
  createdBeats: string[];
  createdSegment: boolean;
  createdHeading: { id: string; standalone: boolean } | null;
  fieldSet: { beat: string; key: string } | null;
  reverts: number | null;
  redoes: number | null;
  skipped: number[];
}

interface Instance { char: string; field: LetterField; owner: string; born: number; state: "alive" | "dead" | "uncertain"; why: string; revival: boolean; killers: Set<number> }

export interface LedgerResult {
  alive: Map<string, { count: number; field: LetterField; revivals: number }>;
  dead: Map<string, string>;
  uncertain: Set<string>;
  beatsAlive: Set<string>;
  beatsDead: Set<string>;
  beatsUncertain: Set<string>;
  losses: { kind: string; char: string; events: number[] }[];
}

// why: letter instances: a typed letter is alive until a command that saw it removes it; an undo brings back what its
// command removed as a new instance; anything the library decides that this cannot know is uncertain
export function settle(events: readonly LedgerEvent[], initial: { char: string; field: LetterField; owner: string }[], beats: string[]): LedgerResult {
  const instances: Instance[] = initial.map(item => ({ ...item, born: -1, state: "alive", why: "", revival: false, killers: new Set() }));
  const beatState = new Map<string, "alive" | "dead" | "uncertain">(beats.map(id => [id, "alive"]));
  const losses: LedgerResult["losses"] = [];
  const byIndex = new Map(events.map(event => [event.index, event]));
  const killedBy = new Map<number, Instance[]>(), revivedBy = new Map<number, Instance[]>(), structural = new Map<number, Instance[]>();
  const ownerOf = new Map<string, string>();
  for (const item of initial) ownerOf.set(item.char, item.owner);
  const seenBy = (event: LedgerEvent, instance: Instance): boolean => instance.born < 0 || event.seen.has(instance.born);
  // why: a command removes what its own copy showed, even when another copy removed the same letter at the same moment;
  // an undo of either one then brings that letter back
  const visibleTo = (event: LedgerEvent, instance: Instance): boolean =>
    (seenBy(event, instance) || instance.born === event.index) && ![...instance.killers].some(killer => event.seen.has(killer) || killer === event.index);
  const kill = (event: LedgerEvent, instance: Instance, list: Map<number, Instance[]>, why: string, structural = false): void => {
    if (!structural && !visibleTo(event, instance)) return;
    if (instance.state !== "uncertain") { instance.state = "dead"; instance.why = why; }
    instance.killers.add(event.index);
    list.set(event.index, [...list.get(event.index) ?? [], instance]);
  };
  const unseenRemoval = (event: LedgerEvent, owner: string, field: LetterField = "visual"): { kind: string; by: LedgerEvent } | null => {
    for (const other of events) {
      if (other.index >= event.index || event.seen.has(other.index)) continue;
      if (field === "name") {
        const made = other.reverts === null ? undefined : byIndex.get(other.reverts)?.createdHeading;
        if (made?.id === owner && made.standalone) return { kind: "typing in a new heading lost when its creator undoes the creation unseen", by: other };
        continue;
      }
      if (other.deletedBeats.includes(owner)) {
        const reverted = events.some(later => later.reverts === other.index);
        return { kind: reverted ? "uncertain" : "unseen visual change discarded with a deleted beat", by: other };
      }
      const undone = other.reverts === null ? undefined : byIndex.get(other.reverts);
      if (undone?.createdBeats.includes(owner)) return { kind: "typing in a new beat lost when its creator undoes the creation unseen", by: other };
    }
    return null;
  };
  const apply = (event: LedgerEvent, revive: boolean): void => {
    for (const typed of event.typed) {
      const instance: Instance = { ...typed, born: event.index, state: "alive", why: "", revival: revive, killers: new Set() };
      instances.push(instance);
      ownerOf.set(typed.char, typed.owner);
      const removal = typed.field === "audio" ? null : unseenRemoval(event, typed.owner, typed.field);
      if (removal?.kind === "uncertain") instance.state = "uncertain";
      else if (removal) { kill(removal.by, instance, structural, removal.kind, true); losses.push({ kind: removal.kind, char: typed.char, events: [event.index, removal.by.index] }); }
    }
    for (const char of event.erased) for (const instance of instances) if (instance.char === char) kill(event, instance, killedBy, "erased");
    // why: an undo of a row deletion restores the row as new items, which a deletion made without seeing that undo
    // cannot reach; the row and what the undo brought back stay
    const restorer = (beat: string): LedgerEvent | undefined => events.find(other => other.index < event.index && !event.seen.has(other.index)
      && other.reverts !== null && byIndex.get(other.reverts)?.deletedBeats.includes(beat));
    const missed = new Set(event.deletedBeats.filter(beat => restorer(beat)));
    const deleted = new Set(event.deletedBeats.filter(beat => !missed.has(beat))), visible = new Set(event.seenVisual);
    for (const beat of deleted) beatState.set(beat, "dead");
    for (const beat of missed) losses.push({ kind: "a deletion missed a row that another person's unseen undo had restored", char: "", events: [restorer(beat)?.index ?? event.index, event.index] });
    for (const instance of instances) {
      if (instance.field !== "visual" || !deleted.has(instance.owner)) continue;
      if (visibleTo(event, instance) && visible.has(instance.char)) kill(event, instance, killedBy, "deleted with its row");
      else if (instance.state === "alive" && events.some(later => later.reverts === event.index)) instance.state = "uncertain";
      else if (instance.state === "alive") {
        kill(event, instance, structural, "unseen visual change discarded with a deleted beat", true);
        losses.push({ kind: "unseen visual change discarded with a deleted beat", char: instance.char, events: [instance.born, event.index] });
      }
    }
    for (const beat of event.createdBeats) beatState.set(beat, "alive");
  };
  for (const event of events) {
    if (event.reverts !== null) {
      const target = byIndex.get(event.reverts);
      if (!target) continue;
      for (const instance of instances) if (instance.born === target.index) kill(event, instance, killedBy, "typing undone");
      for (const instance of killedBy.get(target.index) ?? []) {
        const back: Instance = { ...instance, born: event.index, state: "alive", why: "", revival: true, killers: new Set() };
        instances.push(back);
        revivedBy.set(event.index, [...revivedBy.get(event.index) ?? [], back]);
        // why: undoing a row deletion makes a new visual cell, which another copy's deletion of the old cell cannot reach
        const removal = back.field === "visual" && !target.deletedBeats.includes(back.owner) ? unseenRemoval(event, back.owner) : null;
        if (removal?.kind === "uncertain") back.state = "uncertain";
        else if (removal) { kill(removal.by, back, structural, removal.kind, true); losses.push({ kind: removal.kind, char: back.char, events: [event.index, removal.by.index] }); }
      }
      for (const instance of structural.get(target.index) ?? []) instance.state = "uncertain";
      for (const beat of target.deletedBeats) beatState.set(beat, "alive");
      for (const beat of target.createdBeats) {
        beatState.set(beat, "dead");
        for (const instance of instances) {
          if (instance.owner !== beat || instance.state !== "alive") continue;
          if (instance.field === "audio" && !target.createdSegment) continue;
          const saw = seenBy(event, instance) || instance.born === target.index;
          const kind = saw ? "typing removed by a creation undo the creator saw" : "typing in a new beat lost when its creator undoes the creation unseen";
          kill(event, instance, killedBy, kind, !saw);
          if (instance.born !== target.index && instance.born !== event.index) losses.push({ kind, char: instance.char, events: [instance.born, target.index, event.index] });
        }
      }
      if (target.createdHeading) for (const instance of instances) {
        if (instance.owner !== target.createdHeading.id || instance.state !== "alive" || instance.born === target.index) continue;
        if (target.createdHeading.standalone) {
          const kind = seenBy(event, instance) ? "typing removed by a creation undo the creator saw" : "typing in a new heading lost when its creator undoes the creation unseen";
          kill(event, instance, killedBy, kind, !seenBy(event, instance));
          losses.push({ kind, char: instance.char, events: [instance.born, target.index, event.index] });
        } else instance.field = "audio";
      }
      if (target.fieldSet || target.reverts !== null || target.redoes !== null) for (const instance of instances) if (instance.born === target.index) instance.state = "uncertain";
    } else if (event.redoes !== null) {
      const undo = byIndex.get(event.redoes), target = undo?.reverts === null || undo?.reverts === undefined ? undefined : byIndex.get(undo.reverts);
      if (!undo || !target) continue;
      for (const instance of revivedBy.get(undo.index) ?? []) kill(event, instance, killedBy, "revival redone away");
      for (const instance of instances.filter(item => item.born === target.index && item.killers.has(undo.index))) instances.push({ ...instance, born: event.index, state: "alive", why: "", revival: true, killers: new Set() });
      for (const beat of target.deletedBeats) beatState.set(beat, "dead");
      for (const beat of target.createdBeats) beatState.set(beat, "uncertain");
      // why: the redo restores what the creation undo itself deleted, so letters the creator had seen come back and
      // letters that arrived after the undo stay gone
      for (const instance of killedBy.get(undo.index) ?? []) {
        if (instance.why !== "typing removed by a creation undo the creator saw" || instance.born === target.index || !target.createdBeats.includes(instance.owner)) continue;
        instances.push({ ...instance, born: event.index, state: "alive", why: "", revival: true, killers: new Set() });
        const at = losses.findIndex(loss => loss.kind === instance.why && loss.char === instance.char);
        if (at >= 0) losses.splice(at, 1);
      }
      if (target.createdHeading) for (const instance of instances) if (instance.owner === target.createdHeading.id && instance.state === "dead") instance.state = "uncertain";
    } else apply(event, false);
  }
  const result: LedgerResult = { alive: new Map(), dead: new Map(), uncertain: new Set(), beatsAlive: new Set(), beatsDead: new Set(), beatsUncertain: new Set(), losses };
  for (const instance of instances) {
    if (instance.state === "uncertain") result.uncertain.add(instance.char);
    else if (instance.state === "alive") {
      const known = result.alive.get(instance.char);
      result.alive.set(instance.char, { count: (known?.count ?? 0) + 1, field: instance.field, revivals: (known?.revivals ?? 0) + (instance.revival ? 1 : 0) });
    } else if (!result.alive.has(instance.char)) result.dead.set(instance.char, instance.why);
  }
  for (const char of result.alive.keys()) result.dead.delete(char);
  for (const char of result.uncertain) { result.alive.delete(char); result.dead.delete(char); }
  for (const [beat, state] of beatState) (state === "alive" ? result.beatsAlive : state === "dead" ? result.beatsDead : result.beatsUncertain).add(beat);
  return result;
}
