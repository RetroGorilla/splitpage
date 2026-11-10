import type { CollabIdentity, CollabModel } from "../model.ts";
import type { BindingFollowupInput } from "./cases.ts";

export interface BindingFollowupFacts {
  inserted: { name: string; value: string }[];
  deleted: string[];
  marked: { names: string[]; key: string; value: string | boolean }[];
  updates: number;
  join: boolean;
  comment: boolean;
  split: { source: string; id: string; offset: number } | null;
}

export interface BindingFollowupObservation {
  models: Record<string, CollabModel>;
  bindings: Record<string, CollabIdentity>;
  dom: { id: string; text: string; html: string; selection: [number, number] | null }[];
  errors: string[];
  dirty: boolean;
  composing: boolean;
}

export function checkBindingFollowup(input: BindingFollowupInput, facts: BindingFollowupFacts, observation: BindingFollowupObservation, mechanism: string, lateJoin: boolean): string[] {
  const failures: string[] = [];
  const fail = (message: string): void => { if (!failures.includes(message)) failures.push(message); };
  const values = new Map<string, string>();
  const seedNames = new Map<string, string[]>();
  let serial = 1;
  for (const beat of input.seed) {
    const names: string[] = [];
    for (const value of beat.text) { const name = `s${serial++}`; values.set(name, value); names.push(name); }
    seedNames.set(beat.id, names);
  }
  const target = seedNames.get(input.beat) ?? [];
  for (const name of target.slice(input.from, input.to)) values.delete(name);
  for (const item of facts.inserted) values.set(item.name, item.value);
  for (const name of facts.deleted) values.delete(name);
  const left = target[input.from - 1];
  const right = target[input.to];
  if (observation.errors.length) fail(`binding errors: ${observation.errors.join("; ")}`);
  if (observation.dirty || observation.composing) fail("native buffer is not committed");
  if (!observation.models["A.E"] || !observation.models["B.E"]) fail("required replicas missing");
  const expectedReplicas = ["A.E", "B.E", ...(mechanism === "M3" ? ["A.N", "B.N"] : []), ...(lateJoin ? ["C.E", ...(mechanism === "M3" ? ["C.N"] : [])] : [])];
  if (JSON.stringify(Object.keys(observation.models).sort()) !== JSON.stringify(expectedReplicas.sort())) fail("required E/N/late-join replica coverage missing");
  const identityKey = (identity: CollabIdentity | null): string => identity ? `${identity.client}:${identity.clock}` : "glue";
  for (const [replica, model] of Object.entries(observation.models)) {
    const rows = [...model.rows.map(row => ({ row, recovery: false })), ...model.recovery.map(entry => ({ row: entry.row, recovery: true }))];
    const flat = rows.flatMap(({ row, recovery }) => row.characters.map((character, index) => ({ character, row, index, recovery })));
    const characters = flat.filter(item => item.character.identity !== null);
    const seen = new Set<string>();
    for (const item of characters) {
      const key = identityKey(item.character.identity);
      if (seen.has(key)) fail(`${replica}: duplicated identity ${key}`);
      seen.add(key);
      const bound = observation.bindings[item.character.notation];
      if (!bound || identityKey(bound) !== key) fail(`${replica}: unbound identity ${item.character.notation}`);
    }
    for (const [name, value] of values) {
      const found = characters.filter(item => item.character.notation === name);
      if (found.length !== 1 || found[0]?.character.value !== value) fail(`${replica}: required identity/value ${name} ${JSON.stringify(value)} missing or changed`);
    }
    if (facts.split) {
      const split = facts.split;
      if (rows.filter(item => item.row.id === split.id).length !== 1) fail(`${replica}: remote split boundary missing or duplicated`);
      for (const [index, name] of (seedNames.get(split.source) ?? []).entries()) {
        if (!values.has(name)) continue;
        const item = characters.find(item => item.character.notation === name);
        if (item && item.row.id !== (index < split.offset ? split.source : split.id)) fail(`${replica}: observed seed identity ${name} crossed remote split boundary`);
      }
    }
    const local = characters.filter(item => item.character.identity?.client === 1);
    if (local.length !== input.text.length || local.map(item => item.character.value).join("") !== input.text) fail(`${replica}: local text did not commit once with new identities`);
    for (const item of characters.filter(item => item.character.identity?.client !== 1)) {
      if (!values.has(item.character.notation)) fail(`${replica}: unexpected retained identity ${item.character.notation}`);
    }
    const first = local[0]; const last = local.at(-1);
    const leftItem = characters.find(item => item.character.notation === left);
    const rightItem = characters.find(item => item.character.notation === right);
    if (first && leftItem && (first.row.id !== leftItem.row.id || first.recovery !== leftItem.recovery || flat.indexOf(first) <= flat.indexOf(leftItem))) fail(`${replica}: local text moved away from its painted left identity ${left}`);
    if (last && rightItem && flat.indexOf(last) >= flat.indexOf(rightItem)) fail(`${replica}: local text crossed its painted right identity ${right}`);
    const glue = flat.filter(item => item.character.identity === null);
    if (glue.length !== (facts.join ? 1 : 0) || glue.some(item => item.character.value !== " ")) fail(`${replica}: joining separator missing, changed or duplicated`);
    for (const mark of facts.marked) for (const name of mark.names.filter(name => values.has(name))) {
      const found = characters.find(item => item.character.notation === name);
      if (found?.character.marks[mark.key] !== mark.value) fail(`${replica}: remote mark ${mark.key} lost on ${name}`);
    }
    if (facts.comment && !(model.records?.comments as Record<string, unknown> | undefined)?.C1) fail(`${replica}: remote comment record lost`);
    const baseline = observation.models["A.E"];
    if (baseline && JSON.stringify(model) !== JSON.stringify(baseline)) fail(`${replica}: replicas differ after delivery`);
  }
  const alice = observation.models["A.E"];
  if (alice) {
    if (JSON.stringify(observation.dom.map(row => row.id)) !== JSON.stringify(alice.rows.map(row => row.id))) fail("DOM beat coverage differs from projection");
    for (const row of alice.rows) {
      const dom = observation.dom.find(item => item.id === row.id);
      if (!dom || dom.text !== row.characters.map(character => character.value).join("")) fail(`DOM differs from projection for ${row.id}`);
    }
    const activeLocal = alice.rows.flatMap(row => row.characters.map((character, index) => ({ row, character, index }))).filter(item => item.character.identity?.client === 1);
    const last = activeLocal.at(-1);
    if (last) {
      const selection = observation.dom.find(item => item.id === last.row.id)?.selection;
      if (!selection || selection[0] !== last.index + 1 || selection[1] !== last.index + 1) fail("actual DOM caret is not after committed local text");
    }
  }
  return failures;
}
