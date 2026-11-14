import type { ActionDefinition, ActionRegistry } from "../../application/actions.ts";
import type { RecoveryActionsControl, RecoveryPanelControl, RecoveryPanelPorts } from "./ports.ts";

export function recoveryPanelActions(ports: Pick<RecoveryPanelPorts, "session"> & { readonly current: () => RecoveryPanelControl | null }): [ActionDefinition] {
  return [{ id: "recovery", label: "Recovery", group: "Script", icon: "i-history", words: "removed discarded restore",
    availability: () => { const shared = ports.session.current() !== null; return { enabled: shared, visible: shared }; },
    run: () => { if (ports.session.current()) ports.current()?.open(); } }];
}

export function startRecoveryPanelActions(ports: Pick<RecoveryPanelPorts, "session"> & {
  readonly registry: Pick<ActionRegistry, "register">;
  readonly current: () => RecoveryPanelControl | null;
}): RecoveryActionsControl {
  let release: (() => void) | null = null, off: (() => void) | null = null, stopped = false;
  const leave = () => { off?.(); off = null; release?.(); release = null; };
  const changed = () => {
    if (stopped) return;
    if (!ports.session.current()) { leave(); return; }
    if (!release) release = ports.registry.register(recoveryPanelActions(ports)[0]);
  };
  const enter = () => {
    if (stopped || !ports.session.current()) return;
    if (!off) off = ports.session.onChange(changed);
    changed();
  };
  enter();
  return { enter, leave, dispose: () => { stopped = true; leave(); } };
}
