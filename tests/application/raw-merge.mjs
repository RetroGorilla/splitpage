import { mergeStates } from "../../src/core/merge-states.ts";

export function mergeRawTheirs(base, mine, theirs, ports) {
  return mergeStates(base, mine, theirs, ports);
}
