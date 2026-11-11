import assert from "node:assert/strict";
import type { DeliveryOrder } from "../../../collab/delivery.ts";
import { MarkTraceHistory } from "./driver.ts";
import { markTraceExample, markTraceKinds } from "./replica.ts";
import type { MarkTraceCommand } from "./replica.ts";
import { clampRange } from "../../../../src/core/text/edits.ts";

export function generatedHistory(seed: number, writers: number, order: DeliveryOrder) {
  const initial = "abcdefghijklmnopqrstuvwxyz0123456789";
  const history = new MarkTraceHistory(order, writers, initial + initial);
  let state = seed, commands = 0;
  const pick = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
  const log: string[] = [];
  const kinds = new Set<string>();
  try {
    for (let round = 0; round < 10; round++) {
      const mark = markTraceExample(markTraceKinds[(round + seed) % 10] ?? "b");
      const actions = ["add", "insert", "insert-again", "remove", "delete"] as const;
      for (const action of actions) for (let writer = 0; writer < writers; writer++) {
        history.prepare(writer);
        const characters = history.model.characters(history.known[writer] ?? new Set()), length = characters.length;
        let command: MarkTraceCommand;
        const id = `${writer}-${round}-${action}`;
        if (action === "insert" || action === "insert-again") {
          const extra = action === "insert-again" ? 1 : 0;
          const slot = (round * 2 + extra) * writers + writer + 1, index = characters.findIndex(char => char.id === "s" + slot);
          assert.ok(index >= 0);
          const mode = (["inherit", "plain", "marked"] as const)[(round + writer + seed + extra) % 3] ?? "plain";
          const text = extra && round % 3 === 0 ? "😀" : String.fromCharCode(65 + writer);
          command = { id, kind: "insert", from: index, to: index, text, mode, marks: mode === "marked" ? [mark] : [] };
          kinds.add("insert:" + mode); history.execute(writer, command, slot * 1000 - 500);
        } else if (action === "delete") {
          const candidates = characters.map((char, index) => ({ char, index })).filter(({ char }) => char.birth !== null);
          const selected = candidates[pick(candidates.length)];
          if (!selected) throw new Error("No generated deletion target");
          const range = clampRange([{ text: characters.map(char => char.value).join(""), marks: {} }], selected.index, selected.index + 1);
          command = { id, kind: action, ...range }; history.execute(writer, command);
          kinds.add(action);
        } else {
          const from = pick(length), to = from + 1 + pick(length - from), range = clampRange([{ text: characters.map(char => char.value).join(""), marks: {} }], from, to);
          command = { id, kind: action, ...range, mark }; history.execute(writer, command); kinds.add(action + ":" + mark.kind);
        }
        commands++; log.push(JSON.stringify(history.commands.at(-1)));
      }
      if (round === 4) history.joinEarly();
    }
    const output = history.finish();
    return { output, log, commands, kinds: [...kinds].sort(), deliveries: history.deliveries, checkpoints: history.checkpoints, sequential: history.sequential,
      selective: history.selective, early: history.early, afterJoin: history.afterJoin };
  } catch (error) {
    throw new Error(`seed=${seed} writers=${writers} order=${order}\n${log.join("\n")}\n${String(error)}`, { cause: error });
  } finally { history.destroy(); }
}
