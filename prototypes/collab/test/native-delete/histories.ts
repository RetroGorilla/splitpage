import { base, sole } from "./model.ts";
import type { DeleteCommand, StoredReading } from "./model.ts";

export interface DeleteHistory {
  name: string;
  initial: StoredReading;
  forks: DeleteCommand[][];
}

export const rows = (...ids: string[]): DeleteCommand => ({ op: "rows", ids });
export const type = (id: string, field: "audio" | "visual" | "name", at: number, value = "Ω"): DeleteCommand =>
  ({ op: "type", id, field, at, value });

export function histories(seed: number): DeleteHistory[] {
  const at = seed % 4, inside = 1 + seed % 2;
  const make = (name: string, a: DeleteCommand, b: DeleteCommand[], initial = base): DeleteHistory =>
    ({ name, initial, forks: [[a], b] });
  const joined = structuredClone(base);
  joined.beats.C = { joined: { into: "B", glue: " " } };
  const across = structuredClone(joined);
  across.beats.D = { joined: { into: "C", glue: " " } };
  return [
    make("inline narration", rows("B"), [type("B", "audio", at)]),
    make("head narration", rows("A"), [type("A", "audio", at)]),
    make("tail narration", rows("C"), [type("C", "audio", at)]),
    make("sole segment narration", rows("F"), [type("F", "audio", at)]),
    make("only beat narration", rows("A"), [type("A", "audio", at)], sole),
    make("visual typing", rows("B"), [type("B", "visual", seed % 2)]),
    make("text erase", rows("B"), [{ op: "erase", id: "B", field: seed % 2 ? "visual" : "audio", from: 0, to: 1 }]),
    make("format audio", rows("B"), [{ op: "mark", id: "B", field: "audio", from: 0, to: inside, key: "b" }]),
    make("tag audio", rows("B"), [{ op: "mark", id: "B", field: "audio", from: 1, to: 3, key: "t:T" }]),
    make("tag visual", rows("B"), [{ op: "mark", id: "B", field: "visual", from: 0, to: 1, key: "t:T" }]),
    make("field", rows("B"), [{ op: "field", id: "B", value: "ready" }]),
    make("inline split", rows("B"), [{ op: "split", id: "B", at: inside, created: "N" }, type("N", "visual", 0)]),
    make("head split", rows("A"), [{ op: "split", id: "A", at: inside, created: "N" }, type("N", "visual", 0)]),
    make("only beat split", rows("A"), [{ op: "split", id: "A", at: inside, created: "N" }, type("N", "visual", 0)], sole),
    make("only beat split then narration", rows("A"), [{ op: "split", id: "A", at: inside, created: "N" }, type("N", "audio", 1)], sole),
    make("join deleted up", rows("B"), [{ op: "join", id: "B" }]),
    make("join below to deleted", rows("B"), [{ op: "join", id: "C" }, type("C", "audio", 1)]),
    make("unjoin selected member", rows("B"), [{ op: "unjoin", id: "C" }], joined),
    make("inline heading create", rows("B"), [{ op: "create", above: "B", id: "J", value: "Ω" }]),
    make("segment heading create", rows("A"), [{ op: "create", above: "A", id: "J", value: "Ω" }]),
    make("heading name insert", rows("E"), [type("H", "name", seed % 4)]),
    make("heading name erase", rows("E"), [{ op: "erase", id: "H", field: "name", from: inside - 1, to: inside }]),
    make("heading above flag", rows("E"), [{ op: "heading", id: "H", removal: "flag" }]),
    make("heading above delete", rows("E"), [{ op: "heading", id: "H", removal: "delete" }]),
    make("embedded heading flag versus rename", { op: "heading", id: "H", removal: "flag" }, [type("H", "name", at)]),
    make("embedded heading delete versus rename", { op: "heading", id: "H", removal: "delete" }, [type("H", "name", at)]),
    make("head heading flag versus rename", { op: "heading", id: "I", removal: "flag" }, [type("I", "name", at)]),
    make("head heading delete versus rename", { op: "heading", id: "I", removal: "delete" }, [type("I", "name", at)]),
    make("same row", rows("B"), [rows("B")]),
    make("neighbor left", rows("B"), [rows("A")]),
    make("neighbor right", rows("B"), [rows("C")]),
    make("cross segment joined", rows("B"), [type("D", "audio", at)], across),
    make("run of rows", rows("B", "C", "D"), [type(seed % 2 ? "C" : "D", "audio", at)]),
    make("scene name", { op: "scene", id: "H" }, [type("H", "name", at)]),
    make("scene beat", { op: "scene", id: "H" }, [type("E", "audio", at)]),
    make("scene head", { op: "scene", id: "I" }, [type("F", "audio", at)]),
    make("insert neighbor", rows("B"), [{ op: "insert", before: "D", created: "N", value: "Ω" }, type("N", "visual", 0, "Ψ")])
  ];
}

export function generated(seed: number): DeleteHistory[] {
  return histories(seed).map((history, index) => {
    const { initial, forks } = history;
    const other = initial === sole ? "A" : index % 3 === 0 ? "C" : "F";
    const third = [type(other, "audio", (seed + index) % 4, "Δ"), type(other, "audio", (seed + index) % 4 + 1, "Φ")];
    return { ...history, forks: [...forks, third] };
  });
}
