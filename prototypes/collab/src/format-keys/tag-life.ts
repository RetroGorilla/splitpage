import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import type { NativeScheme } from "../native/variant.ts";
import { countKeys, quantile } from "./keys.ts";
import { random } from "./life.ts";
import { firstDifference, printCell } from "./model.ts";
import { TAG_T, TAG_U, TagLifeModel } from "./tag-model.ts";
import type { TagFormatEdit } from "./tag-model.ts";
import { TagReplica, nestedTags, pullTags } from "./tag-replica.ts";

const DAYS = 250;
const CELLS = 192;
const SLOTS = 8;
const SLOT_LENGTH = 24;
const FRESH = 6;
const LENGTHS = [4, 8, 12, 20] as const;
const LIFE_SEED = 604;
const LINE = "lens slate lead cue fog ";
const initial = LINE.repeat(Math.ceil(SLOTS * SLOT_LENGTH / LINE.length)).slice(0, SLOTS * SLOT_LENGTH);
const tagNames = [TAG_T, TAG_U, "t:t_cdefghi", "t:t_defghij", "t:t_efghijk", "t:t_fghijkl"] as const;
const categories = ["prop", "location", "cast", "vfx", "sound", "gear"] as const;

function tagTape(): TagFormatEdit[] {
  const next = random(LIFE_SEED);
  const pick = (length: number) => Math.floor(next() * length);
  const spots = Array.from({ length: CELLS * SLOTS }, (_, index): TagFormatEdit => {
    const from = (index % SLOTS) * SLOT_LENGTH + 2;
    return { cell: `beat-${Math.floor(index / SLOTS)}`, op: "add", name: tagNames[pick(tagNames.length)] ?? TAG_T,
      from, to: from + (LENGTHS[pick(LENGTHS.length)] ?? 4) };
  });
  for (let index = spots.length - 1; index > 0; index--) {
    const other = pick(index + 1), spot = spots[index], swap = spots[other];
    if (!spot || !swap) throw new Error("Missing tag slot");
    spots[index] = swap;
    spots[other] = spot;
  }
  const tape: TagFormatEdit[] = [], live: TagFormatEdit[] = [];
  for (let day = 0; day < DAYS; day++) {
    const fresh = spots.slice(day * FRESH, (day + 1) * FRESH);
    tape.push(...fresh);
    live.push(...fresh);
    const repeat = live[pick(live.length)], reapply = live[pick(live.length)];
    const [removed] = live.splice(pick(live.length), 1);
    if (!repeat || !reapply || !removed) throw new Error("No applied tag to revise");
    tape.push(repeat, { ...reapply, op: "remove" }, reapply, { ...removed, op: "remove" });
  }
  return tape;
}

class TagLife {
  readonly server = new Y.Doc();
  readonly writers: TagReplica[];
  readonly baseline: number;
  private readonly scheme: NativeScheme;
  private readonly cells: Readonly<Record<string, string>>;
  private readonly model: TagLifeModel;

  constructor(scheme: NativeScheme, cells: Readonly<Record<string, string>>, writers: number) {
    this.scheme = scheme;
    this.cells = cells;
    const fixture = new TagReplica(900, scheme);
    try {
      fixture.hydrate({ rows: Object.entries(cells).map(([id, visualText]) => ({ id, visualText })),
        productionTags: tagNames.map((name, index) => ({ id: name.slice(2), cat: categories[index], name: `Item ${index + 1}` })) });
      Y.applyUpdate(this.server, fixture.encode());
    } finally { fixture.destroy(); }
    this.baseline = this.bytes();
    this.writers = Array.from({ length: writers }, (_, index) => {
      const copy = new TagReplica(2_000_000_000 + index * 991, scheme);
      copy.doc.on("update", (update, origin) => { if (origin !== "remote") Y.applyUpdate(this.server, update); });
      return copy;
    });
    this.model = new TagLifeModel(cells, scheme === "act");
  }

  run(edit: TagFormatEdit, writer: number): void {
    const copy = this.writers[writer];
    if (!copy) throw new Error("Missing writer");
    pullTags(copy, this.server);
    copy.editTagCell(edit);
    this.model.apply(edit);
    this.check(copy, edit.cell);
  }

  private check(copy: TagReplica, cell: string): void {
    const want = this.model.view(cell);
    const got = copy.tagView(cell, true);
    if (firstDifference(want, got) >= 0) throw new Error(`${cell} should show ${printCell(want)} but shows ${printCell(got)}`);
  }

  bytes(): number { return Y.encodeStateAsUpdate(this.server).length; }

  snapshot(timing: boolean) {
    const reader = new TagReplica(901, this.scheme);
    try {
      pullTags(reader, this.server);
      const counts: number[] = [];
      let busiest = "", most = -1;
      for (const cell of Object.keys(this.cells)) {
        this.check(reader, cell);
        const { perCharacter, total } = countKeys(reader.tagDelta(cell));
        for (const value of perCharacter) if (value > 0) counts.push(value);
        if (total > most) { busiest = cell; most = total; }
      }
      const reads: number[] = [], types: number[] = [];
      if (timing) {
        for (let sample = 0; sample < 51; sample++) {
          const started = performance.now();
          nestedTags(reader.tagView(busiest));
          reads.push(performance.now() - started);
        }
        for (let sample = 0; sample < 21; sample++) {
          const copy = new TagReplica(902, this.scheme);
          try {
            pullTags(copy, this.server);
            const started = performance.now();
            copy.editTagCell({ op: "insert", cell: busiest, at: 1, letter: "X" });
            types.push(performance.now() - started);
          } finally { copy.destroy(); }
        }
      }
      return { characters: counts.length, median: quantile(counts, 0.5), p95: quantile(counts, 0.95), max: quantile(counts, 1),
        bytes: this.bytes() - this.baseline, busiest, busiestLoad: most, readMs: quantile(reads, 0.5), typeMs: quantile(types, 0.5) };
    } finally { reader.destroy(); }
  }

  destroy(): void {
    for (const writer of this.writers) writer.destroy();
    this.server.destroy();
  }
}

export function tagLife(scheme: NativeScheme, writers: number) {
  const started = performance.now(), tape = tagTape();
  const life = new TagLife(scheme, Object.fromEntries(Array.from({ length: CELLS }, (_, index) => [`beat-${index}`, initial])), writers);
  try {
    tape.forEach((edit, index) => life.run(edit, index % writers));
    const applications = tape.filter(edit => edit.op === "add").length;
    return { ...life.snapshot(true), days: DAYS, applications, removals: tape.length - applications,
      textCharacters: CELLS * initial.length, seconds: (performance.now() - started) / 1000 };
  } finally { life.destroy(); }
}

export function tagStress(scheme: NativeScheme, punch: boolean) {
  const life = new TagLife(scheme, { one: initial }, 1);
  const span = { cell: "one", name: TAG_T, from: 20, to: 70 };
  const rows = [];
  try {
    life.run({ ...span, op: "add" }, 0);
    for (let round = 1; round <= 300; round++) {
      life.run(punch ? { ...span, from: 45, to: 46, op: "remove" } : { ...span, op: "remove" }, 0);
      const cleared = round === 100 || round === 300 ? life.snapshot(false) : undefined;
      life.run({ ...span, op: "add" }, 0);
      if (cleared) rows.push({ round, clearedMax: cleared.max, ...life.snapshot(false) });
    }
    return rows;
  } finally { life.destroy(); }
}
