export type CollaborateStep = "checking" | "connect" | "sign-in" | "publish" | "links";

export interface WorkflowRun {
  readonly seq: number;
}

export interface WorkflowGate<R extends WorkflowRun> {
  current: () => R | null;
  seq: () => number;
}

export function runIsStale<R extends WorkflowRun>(gate: WorkflowGate<R>, run: R): boolean {
  const live = gate.current();
  return live === null || live !== run || run.seq !== gate.seq();
}
