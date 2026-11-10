import type { GeneratedHistory } from "./generator.ts";

export const minimalHistories: Record<string, GeneratedHistory> = {
  "status-redo-conflict": { writers: 3, reorderWithinSender: false, steps: [
    { op: "status", writer: 1, r: [0.505, 0.804, 0.455] },
    { op: "bold", writer: 0, r: [0.724, 0.97, 0.21] },
    { op: "replace", writer: 0, r: [0.866, 0.352, 0.236] },
    { op: "status", writer: 2, r: [0.405, 0.039, 0.986] },
    { op: "status", writer: 1, r: [0.405, 0.512, 0.109] },
    { op: "deliver", writer: 2, r: [0.788, 0.856, 0.064] },
    { op: "deliver", writer: 2, r: [0.807, 0.306, 0.395] },
    { op: "undo-redo", writer: 1, r: [0.187, 0.572, 0.506] }
  ] },
  "join-target": { writers: 2, reorderWithinSender: true, steps: [
    { op: "move", writer: 1, r: [0.245, 0.339, 0.904] },
    { op: "join", writer: 1, r: [0.397, 0.82, 0.724] },
    { op: "remove", writer: 1, r: [0.061, 0.185, 0.091] }
  ] },
  "recovery-attribution": { writers: 3, reorderWithinSender: false, steps: [
    { op: "remove", writer: 2, r: [0.153, 0.014, 0.696] },
    { op: "remove", writer: 1, r: [0.281, 0.531, 0.346] }
  ] },
  "pending-update": { writers: 3, reorderWithinSender: true, steps: [
    { op: "heading", writer: 0, r: [0.632, 0.698, 0.587] },
    { op: "unheading", writer: 0, r: [0.73, 0.642, 0.367] },
    { op: "heading", writer: 2, r: [0.083, 0.359, 0.346] },
    { op: "deliver", writer: 1, r: [0.419, 0.818, 0.738] },
    { op: "move", writer: 1, r: [0.189, 0.286, 0.662] }
  ] }
};
