import { productionReaders } from "../legacy/document-ports.ts";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import { migrateRows } from "../js/02-state.js";
import { healTagRegistry, productionIndexStats } from "../js/07-production-tags.js";
import { productionIndex } from "../legacy/production-index-bridge.ts";
import { currentDocument } from "../legacy/session-bridge.ts";
import { deriveProductionIndex } from "../core/production/tags.ts";
import { loadTestDocument } from "./_document.mjs";

const tag = (cat, name) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${name}</span>`;
const row = (id, audioText, visualText) => ({ id, status: "todo", audioText, visualText });

export function seededHealRounds(seed, rounds) {
  const cats = ["prop", "location", "cast", "vfx", "gear"];
  const names = ["kettle", "Kettle", "mug", "pier", "Ada", "steam", "drone", "lamp", String.fromCharCode(0x2060), String.fromCharCode(0xad)];
  const cues = ["slow", "rain", "door slam", "thunder"];
  const cue = (name) => `<span class="audio-cue">Music: ${name}</span>`;
  const rand = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) % n;
  };
  const tags = () => {
    let html = "";
    for (let k = 0; k < rand(4); k++) html += "x " + tag(cats[rand(cats.length)], names[rand(names.length)]) + " ";
    return html;
  };
  const check = (handed, handedIds, label) => {
    const fresh = deriveProductionIndex(S.state, productionReaders);
    assert.deepEqual(productionIndex().current(currentDocument()), fresh, label);
    assert.deepEqual(productionIndex().entries(currentDocument()).map((e) => [e.key, e.id, e.name, e.orphaned]),
      fresh.entries.map((e) => [e.key, e.id, e.name, e.orphaned]), label);
    assert.deepEqual(handed.map((e) => e.id), handedIds, label + ": an entry handed out before the heal keeps its id");
    const handedKeys = handed.map((e) => e.key), freshKeys = fresh.entries.map((e) => e.key);
    if (fresh.unregistered.length && handedKeys.join("|") !== freshKeys.join("|") &&
        handedKeys.slice().sort().join("|") === freshKeys.slice().sort().join("|")) reorderedHeals++;
    const derived = productionIndexStats().derived;
    assert.equal(healTagRegistry(), 0, label + ": a heal right after counted names again");
    assert.equal(productionIndexStats().derived, derived, label + ": a heal right after re-derived the index");
    assert.deepEqual(productionIndex().current(currentDocument()), fresh, label + ": a heal right after changed the index");
  };
  let healedRounds = 0, retitledRounds = 0, idsMoved = 0, refusedRounds = 0, reorderedHeals = 0;
  for (let round = 0; round < rounds; round++) {
    const rows = [];
    for (let r = 0; r < 1 + rand(4); r++) {
      let audio = tags();
      if (rand(2)) audio += "<br>" + cue(cues[rand(cues.length)]);
      rows.push(row("r" + r, audio, tags()));
    }
    const productionTags = [];
    for (let t = 0; t < rand(4); t++) {
      const cat = cats[rand(cats.length)], name = names[rand(names.length)];
      productionTags.push({ id: "t_" + round + "_" + t, cat, name, owner: "", notes: "", status: "needed" });
    }
    loadTestDocument(migrateRows({ schema: 2, title: "Shims", docId: "d" + "6".repeat(32), rows, comments: [] }));
    S.state.productionTags = productionTags;
    const label = "round " + round;
    const first = productionIndex().entries(currentDocument());
    const firstIds = first.map((e) => e.id);
    if (healTagRegistry()) healedRounds++;
    check(first, firstIds, label + " first heal");
    if (productionIndex().current(currentDocument()).unregistered.length) refusedRounds++;

    const target = S.state.rows[rand(rows.length)];
    const newCue = cues[rand(cues.length)] + [" piano", "s", " storm"][rand(3)];
    target.audioText = target.audioText.replace(/<br><span class="audio-cue">.*<\/span>$/, "") + "<br>" + cue(newCue);
    if (rand(2)) target.visualText += tag(cats[rand(cats.length)], names[rand(names.length)]);
    const handed = productionIndex().entries(currentDocument());
    const handedIds = handed.map((e) => e.id);
    const namesBefore = new Map(S.state.productionTags.map((t) => [t.id, t.name]));
    healTagRegistry();
    if (S.state.productionTags.some((t) => namesBefore.has(t.id) && namesBefore.get(t.id) !== t.name)) retitledRounds++;
    if (productionIndex().entries(currentDocument()).some((e, i) => handed[i] && handed[i].key === e.key && handed[i].id !== e.id)) idsMoved++;
    check(handed, handedIds, label + " second heal");
  }
  return { healedRounds, retitledRounds, idsMoved, refusedRounds, reorderedHeals };
}
