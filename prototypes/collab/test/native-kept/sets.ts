import { b, h } from "../native-chosen/kit.ts";
import type { Spec } from "../native-chosen/kit.ts";
import type { DeleteCommand } from "../native-delete/model.ts";
import type { E10Command } from "../native-moves/e10-model.ts";
import type { KeptCommand } from "./replay.ts";

export const e10Spec: Spec = {
  order: ["scene-P", "beat-D", "scene-Q"],
  segments: {
    "scene-P": { head: h("P"), units: ["x", b("A"), "ab", b("B"), "cd", b("C"), "ef"] },
    "beat-D": { head: b("D"), units: ["gh"] },
    "scene-Q": { head: h("Q"), units: ["y", b("E"), "ij", b("F"), "kl", b("G"), "mn", b("H"), "op"] }
  },
  beats: { A: { note: "one" }, B: { note: "two" }, C: { paragraphStart: true }, D: {}, E: {}, F: {}, G: {}, H: {} },
  visuals: { A: "A", B: "B", C: "C", D: "D", E: "E", F: "F", G: "G", H: "H" },
  headings: { P: {}, Q: {} }
};

export function e9Command(cmd: DeleteCommand): KeptCommand {
  switch (cmd.op) {
    case "rows": return { op: "delete", rows: cmd.ids };
    case "scene": return { op: "sceneDelete", id: cmd.id };
    case "heading": return { op: "removeHeading", id: cmd.id };
    case "type": return { ...cmd, text: cmd.value };
    case "erase": return cmd;
    case "mark": return { ...cmd, op: "format", on: true };
    case "field": return { ...cmd, key: "status" };
    case "split": case "join": case "unjoin": return cmd;
    case "insert": return { op: "insert", before: cmd.before, id: cmd.created, text: cmd.value };
    case "create": return { op: "heading", above: cmd.above, id: cmd.id, text: cmd.value };
  }
}

const strip = (id: string): string => id.replace(/^#/, "");

export function e10Command(cmd: E10Command): KeptCommand {
  switch (cmd.op) {
    case "move": {
      const { drop } = cmd, scene = drop.unit === "scene";
      return { op: "move", drop: { ...drop, first: scene ? strip(drop.first) : drop.first, target: scene && drop.target ? strip(drop.target) : drop.target } };
    }
    case "type": return { ...cmd, field: cmd.field === "audioText" ? "audio" : "visual" };
    case "format": case "tag": return { ...cmd, op: "format", field: "audio", on: true };
    case "field": case "undo": case "redo": return cmd;
    case "join": case "unjoin": return { op: cmd.op, id: cmd.id };
    case "split": return { ...cmd, created: cmd.newId };
    case "delete": return { op: "delete", rows: [cmd.id] };
    case "removeHeading": return { op: cmd.op, id: strip(cmd.id) };
    case "heading": return { op: "heading", above: cmd.id, id: strip(cmd.newId), text: cmd.text };
    case "rename": return { op: "type", id: strip(cmd.id), field: "name", at: cmd.at, text: cmd.text };
  }
}
