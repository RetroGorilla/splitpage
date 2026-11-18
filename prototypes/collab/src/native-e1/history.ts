import * as Y from "yjs";
import { Composition, applyOps } from "./fold.ts";
import { Ledger, label, malformed, view } from "./ledger.ts";
import type { LedgerStep, OrderBreak, Seen } from "./ledger.ts";

export type CommitStrategy = "fold" | "relative" | "offsets";
export interface ComposedHistoryOptions { readonly seed: number; readonly strategy?: CommitStrategy; readonly undo?: boolean }
export interface ComposedHistory {
  readonly seed: number;
  readonly commands: readonly string[];
  readonly hard: readonly string[];
  readonly order: readonly OrderBreak[];
  readonly liveOrder: readonly OrderBreak[];
  readonly text: string;
  readonly ended: "commit" | "cancel";
  readonly undone: boolean;
  readonly redone: boolean;
  readonly ledger: Ledger;
  readonly final: readonly Seen[];
  readonly typed: readonly string[];
  readonly tally: Readonly<Record<string, number>>;
}

interface Copy {
  readonly name: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly log: Uint8Array[];
  readonly undo: Y.UndoManager;
  readonly origin: { readonly copy: string };
  readonly plain: { readonly copy: string };
  readonly stack: LedgerStep[];
  readonly redone: Map<string, string>;
  redo: LedgerStep[];
}

interface ScreenToken { readonly key: string; readonly local: boolean; readonly units: number }

export const DELIVERY = "delivery";

export function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function copyOf(name: string, client: number, seedUpdate: Uint8Array): Copy {
  const doc = new Y.Doc();
  doc.clientID = client;
  const text = doc.getText("t"), origin = { copy: name };
  const undo = new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  const copy: Copy = { name, doc, text, log: [], undo, origin, plain: { copy: `${name} untracked` }, stack: [], redone: new Map(), redo: [] };
  doc.on("update", (update: Uint8Array, from: unknown) => { if (from !== DELIVERY) copy.log.push(update); });
  Y.applyUpdate(doc, seedUpdate, DELIVERY);
  return copy;
}

const ids = (seen: readonly Seen[]): Set<string> => new Set(seen.map(item => item.id));
const sorted = (tokens: readonly string[]): string => [...tokens].sort().join(" ");
const unitsBefore = (seen: readonly { units: number }[], index: number): number => seen.slice(0, index).reduce((sum, item) => sum + item.units, 0);

// why: one composing copy A, two writers B and C and a late joiner; every update goes out in random order with repeats,
// and what each step should keep, drop and order is recorded from the commands before the step runs
export function runHistory(options: ComposedHistoryOptions): ComposedHistory {
  const random = randomSource(options.seed), strategy = options.strategy ?? "fold";
  const int = (below: number): number => Math.floor(random() * below);
  const commands: string[] = [], hard: string[] = [], ledger = new Ledger(), tally: Record<string, number> = {};
  const note = (name: string, amount = 1): void => { tally[name] = (tally[name] ?? 0) + amount; };
  const delivered = new Map<string, number[]>();
  let serial = 0;
  const fresh = (allowEmbeds: boolean): string | Record<string, string> => {
    serial++;
    const roll = random();
    if (roll < 0.6 || (!allowEmbeds && roll < 0.75)) return String.fromCodePoint(0x4e00 + serial);
    if (roll < 0.85 || !allowEmbeds) return String.fromCodePoint(0x20000 + serial);
    return roll < 0.95 ? { k: `s${serial}` } : { b: `b${serial}` };
  };
  const tokenText = (token: string | Record<string, string>): string => typeof token === "string" ? token : JSON.stringify(token);
  const keyOf = (seen: Seen | undefined): string | undefined => {
    if (seen === undefined) return undefined;
    const key = ledger.keyOf(seen.id);
    if (key === undefined) hard.push(`unknown instance ${label(seen.token)} seen while recording`);
    return key;
  };
  const insertTokens = (text: Y.Text, at: number, tokens: readonly (string | Record<string, string>)[]): void => {
    let position = at;
    for (const token of tokens) {
      if (typeof token === "string") { text.insert(position, token); position += token.length; } else { text.insertEmbed(position, token); position++; }
    }
  };

  const baseTokens = Array.from({ length: 2 + int(6) }, () => fresh(true));
  const baseKeys = baseTokens.map(tokenText);
  for (const key of baseKeys) ledger.add(key, key);
  ledger.between(undefined, baseKeys, undefined);
  commands.push(`base ${baseKeys.map(label).join(" ")}`);
  const seedDoc = new Y.Doc();
  seedDoc.clientID = 100;
  seedDoc.transact(() => insertTokens(seedDoc.getText("t"), 0, baseTokens));
  for (const key of ledger.bindSeen(view(seedDoc.getText("t")), baseKeys)) hard.push(`base ${label(key)} not written`);
  const seedUpdate = Y.encodeStateAsUpdate(seedDoc);
  seedDoc.destroy();
  const copies = [copyOf("A", 1, seedUpdate), copyOf("B", 2, seedUpdate), copyOf("C", 3, seedUpdate)];
  const [a, b, c] = copies as [Copy, Copy, Copy];
  let composition: Composition | null = null, relative: Y.RelativePosition[] = [], screen: ScreenToken[] = [];
  const intended = new Set<string>();
  let typedAtCommit: string[] = [], deletedDuringComposition = 0;

  const deliver = (): void => {
    const from = copies[int(copies.length)] as Copy;
    if (from.log.length === 0) return;
    const others = copies.filter(copy => copy !== from), to = others[int(others.length)] as Copy, index = int(from.log.length);
    commands.push(`deliver ${from.name}#${index} to ${to.name}`);
    const pair = `${from.name}>${to.name}`, earlier = delivered.get(pair) ?? [];
    note("deliveries");
    let next = 0;
    while (earlier.includes(next)) next++;
    if (earlier.includes(index)) note("repeated deliveries");
    else if (index !== next) note("out-of-order deliveries");
    delivered.set(pair, [...earlier, index]);
    if (to === a && composition !== null) note("deliveries to the composer while composing");
    Y.applyUpdate(to.doc, from.log[index] as Uint8Array, DELIVERY);
    if (to === a && composition !== null && composition.liveUnits() !== a.text.length) hard.push(`fold out of step: ${composition.liveUnits()} units against ${a.text.length}`);
  };

  const runUndo = (copy: Copy, kind: "undo" | "redo"): boolean => {
    const before = view(copy.text), beforeIds = ids(before), state = Y.decodeStateVector(Y.encodeStateVector(copy.doc));
    const held = (id: string): boolean => { const [client, clock] = id.split(":").map(Number); return clock !== undefined && clock < (state.get(client ?? -1) ?? 0); };
    const forecast = ledger.forecast(kind === "undo" ? copy.stack : copy.redo, beforeIds, copy.redone);
    const restored = (forecast?.restores ?? []).map(original => {
      serial++;
      const key = `${ledger.token(original)}#${serial}`;
      ledger.restore(original, key, held, new Set(forecast?.restores));
      copy.redone.set(original, key);
      return key;
    });
    for (const key of forecast?.deletes ?? []) ledger.kill(key);
    const result = kind === "undo" ? copy.undo.undo() : copy.undo.redo();
    commands.push(`${copy.name} ${kind}`);
    const after = view(copy.text), afterIds = ids(after);
    if (forecast === null) {
      if (result !== null) hard.push(`${copy.name} ${kind} changed something the commands say was used up`);
      return false;
    }
    if (result === null) hard.push(`${copy.name} ${kind} did nothing although the commands say it should`);
    const vanished = before.filter(seen => !afterIds.has(seen.id)).map(seen => seen.id);
    if (sorted(vanished) !== sorted(forecast.deletes.map(key => ledger.idOf(key) ?? ""))) hard.push(`${copy.name} ${kind} removed ${vanished.length} instances, the commands say ${forecast.deletes.length}`);
    const appeared = after.filter(seen => !beforeIds.has(seen.id));
    if (appeared.length !== restored.length) hard.push(`${copy.name} ${kind} brought back ${appeared.map(seen => label(seen.token)).join("")}, the commands say ${restored.map(key => label(ledger.token(key))).join("")}`);
    ledger.bindSeen(appeared, restored);
    (kind === "undo" ? copy.redo : copy.stack).push({ actor: copy.name, inserted: restored, deleted: forecast.deletes });
    return true;
  };

  const remote = (copy: Copy): void => {
    const seen = view(copy.text), roll = random();
    if (roll < 0.4 || seen.length === 0) {
      const index = int(seen.length + 1), tokens = Array.from({ length: 1 + int(3) }, () => fresh(true)), keys = tokens.map(tokenText);
      for (const key of keys) ledger.add(key, key);
      ledger.between(keyOf(seen[index - 1]), keys, keyOf(seen[index]));
      copy.undo.stopCapturing();
      copy.doc.transact(() => insertTokens(copy.text, unitsBefore(seen, index), tokens), copy.origin);
      ledger.bindSeen(view(copy.text), keys);
      copy.stack.push({ actor: copy.name, inserted: keys, deleted: [] });
      copy.redo = [];
      note("remote insertions");
      for (const token of tokens) note(typeof token !== "string" ? ("b" in token ? "remote splits" : "remote atoms") : token.length > 1 ? "remote surrogate pairs" : "remote letters");
      commands.push(`${copy.name} types ${keys.map(label).join("")} at ${index}`);
    } else if (roll < 0.7) {
      const index = int(seen.length), doomed = seen.slice(index, index + 1 + int(Math.min(3, seen.length - index)));
      const keys = doomed.map(keyOf).filter((key): key is string => key !== undefined);
      for (const key of keys) ledger.kill(key);
      copy.undo.stopCapturing();
      copy.doc.transact(() => copy.text.delete(unitsBefore(seen, index), unitsBefore(doomed, doomed.length)), copy.origin);
      copy.stack.push({ actor: copy.name, inserted: [], deleted: keys });
      copy.redo = [];
      note("remote deletions");
      if (doomed.some(item => item.token.startsWith("{"))) note("remote deletions of atoms or boundaries");
      commands.push(`${copy.name} deletes ${doomed.map(item => label(item.token)).join("")}`);
    } else if (roll < 0.85 || options.undo === false) {
      const index = int(seen.length), range = seen.slice(index, index + 1 + int(Math.min(3, seen.length - index))), value = random() < 0.6 ? true : null;
      copy.doc.transact(() => copy.text.format(unitsBefore(seen, index), unitsBefore(range, range.length), { b: value }), copy.plain);
      note("remote formatting");
      commands.push(`${copy.name} ${value ? "bolds" : "unbolds"} ${range.map(item => label(item.token)).join("")}`);
    } else {
      note(runUndo(copy, "undo") ? "remote undo" : "remote undo with nothing left");
    }
  };

  const tryComposition = (what: string, change: (edit: Composition) => void): void => {
    if (composition === null) return;
    try { change(composition); } catch (error) { hard.push(`composition refused ${what}: ${(error as Error).message}`); }
  };

  const typeLocally = (at: number, right: string | undefined): string[] => {
    const keys = Array.from({ length: 1 + int(2) }, () => fresh(false) as string);
    for (const key of keys) ledger.add(key, key);
    ledger.between(screen[at - 1]?.key, keys, right, "screen");
    tryComposition("an insertion", edit => edit.insert(unitsBefore(screen, at), keys.join("")));
    screen.splice(at, 0, ...keys.map(key => ({ key, local: true, units: key.length })));
    return keys;
  };

  const composeAway = (at: number, length: number): ScreenToken[] => {
    const doomed = screen.slice(at, at + length);
    for (const token of doomed) {
      if (token.local) { ledger.kill(token.key); deletedDuringComposition++; } else intended.add(token.key);
    }
    tryComposition("a deletion", edit => edit.delete(unitsBefore(screen, at), unitsBefore(screen, at + length)));
    screen.splice(at, length);
    return doomed;
  };

  const compose = (): void => {
    if (composition === null) return;
    const roll = random();
    note("composition steps");
    if (roll < 0.45 || screen.length === 0) {
      const index = int(screen.length + 1);
      commands.push(`A composes ${typeLocally(index, screen[index]?.key).map(label).join("")} at ${index}`);
      return;
    }
    const index = int(screen.length), length = 1 + int(Math.min(2, screen.length - index)), right = screen[index + length]?.key;
    const doomed = composeAway(index, length);
    if (roll < 0.75) { commands.push(`A composes away ${doomed.map(token => label(token.key)).join("")}`); return; }
    commands.push(`A composes ${typeLocally(index, right).map(label).join("")} over ${doomed.map(token => label(token.key)).join("")}`);
  };

  const commit = (): void => {
    if (composition === null) return;
    const typed = screen.filter(token => token.local).map(token => token.key);
    typedAtCommit = typed;
    const before = view(a.text), visible = ids(before);
    const deletes = [...intended].filter(key => visible.has(ledger.idOf(key) ?? ""));
    deletedDuringComposition += deletes.length;
    const reachable = screen.filter(token => token.local || visible.has(ledger.idOf(token.key) ?? ""));
    reachable.forEach((token, index) => {
      const next = reachable[index + 1];
      if (next !== undefined && (token.local || next.local)) ledger.before(token.key, next.key, "commit");
    });
    for (const key of deletes) ledger.kill(key);
    a.undo.stopCapturing();
    if (composition.folded > 0) note("commits after remote changes were folded");
    if (deletes.length < intended.size) note("commits where a remote copy had already deleted text the person deleted");
    if (reachable.length < screen.length) note("commits with a deleted character still on screen");
    if (strategy === "fold") composition.commit(a.origin);
    else {
      const plan = composition.plan();
      composition.cancel();
      const resolve = (painted: number): number => strategy === "offsets" ? painted : Y.createAbsolutePositionFromRelativePosition(relative[painted] as Y.RelativePosition, a.doc)?.index ?? 0;
      const ops = [
        ...plan.runs.map((run, order) => ({ at: run.anchor < 0 ? 0 : resolve(run.anchor) + 1, order, insert: run.text })),
        ...plan.deleted.map(painted => ({ at: resolve(painted), order: Number.MAX_SAFE_INTEGER }))
      ];
      if (ops.length > 0) a.doc.transact(() => applyOps(a.text, ops), a.origin);
    }
    composition = null;
    commands.push("A commits");
    const after = view(a.text), afterIds = ids(after);
    const vanished = before.filter(seen => !afterIds.has(seen.id));
    if (sorted(vanished.map(seen => seen.id)) !== sorted(deletes.map(key => ledger.idOf(key) ?? ""))) hard.push(`commit removed ${vanished.map(seen => label(seen.token)).join("")}, the person removed ${deletes.map(key => label(ledger.token(key))).join("")}`);
    const appeared = after.filter(seen => !visible.has(seen.id));
    if (sorted(appeared.map(seen => seen.token)) !== sorted(typed)) hard.push(`commit wrote ${appeared.map(seen => label(seen.token)).join("")}, the person typed ${typed.map(label).join("")}`);
    ledger.bindSeen(appeared, typed);
    if (typed.length > 0 || deletes.length > 0) { a.stack.push({ actor: "A", inserted: typed, deleted: deletes }); a.redo = []; }
  };

  const events = (total: number, local: boolean): void => {
    for (let index = 0; index < total; index++) {
      const roll = random();
      if (local && roll < 0.35) compose();
      else if (roll < 0.65) remote(random() < 0.5 ? b : c);
      else deliver();
    }
  };

  events(int(4), false);
  const painted = view(a.text);
  screen = painted.flatMap(seen => { const key = keyOf(seen); return key === undefined ? [] : [{ key, local: false, units: seen.units }]; });
  composition = new Composition(a.text);
  relative = Array.from({ length: a.text.length }, (_, index) => Y.createRelativePositionFromTypeIndex(a.text, index));
  commands.push(`A starts composing over ${painted.map(seen => label(seen.token)).join("")}`);
  events(3 + int(10), true);
  const logged = a.log.length;
  const ended = random() < 0.85 ? "commit" : "cancel";
  if (ended === "commit") commit();
  else {
    for (const token of screen) if (token.local) ledger.kill(token.key);
    composition.cancel();
    composition = null;
    commands.push("A cancels");
    if (a.log.length !== logged) hard.push("a cancelled composition wrote to the document");
  }
  events(int(7), false);
  let undone = false, redone = false;
  if (options.undo !== false && ended === "commit" && random() < 0.6) {
    undone = runUndo(a, "undo");
    events(int(5), false);
    if (undone && random() < 0.6) { redone = runUndo(a, "redo"); events(int(5), false); }
  }

  for (let round = 0; round < 6; round++) {
    const total = copies.reduce((sum, copy) => sum + copy.log.length, 0), updates = copies.flatMap(copy => copy.log);
    for (const copy of copies) {
      for (const update of [...updates, ...updates.filter(() => random() < 0.2)].sort(() => random() - 0.5)) Y.applyUpdate(copy.doc, update, DELIVERY);
    }
    if (copies.reduce((sum, copy) => sum + copy.log.length, 0) === total) break;
  }
  const late = new Y.Doc();
  late.clientID = 4;
  const lateUpdates = [seedUpdate, ...copies.flatMap(copy => copy.log)];
  for (const update of [...lateUpdates, ...lateUpdates.filter(() => random() < 0.2)].sort(() => random() - 0.5)) Y.applyUpdate(late, update, DELIVERY);
  const shown = [...copies.map(copy => copy.text), late.getText("t")].map(text => JSON.stringify(text.toDelta()));
  if (new Set(shown).size !== 1) hard.push(`copies disagree: ${shown.join(" | ")}`);
  const final = view(a.text), findings = ledger.check(final);
  hard.push(...findings.identity, ...malformed(final.map(seen => seen.token)));
  for (const copy of copies) { copy.undo.destroy(); copy.doc.destroy(); }
  late.destroy();
  note(ended === "commit" ? "commits" : "cancels");
  if (undone) note("composer undo");
  if (redone) note("composer redo");
  if (ended === "commit") { note("typed tokens committed", typedAtCommit.length); note("deletions committed or made during composition", deletedDuringComposition); }
  return { seed: options.seed, commands, hard, order: findings.order, liveOrder: findings.liveOrder, text: final.map(seen => label(seen.token)).join(""), ended, undone, redone, ledger, final, typed: typedAtCommit, tally };
}
