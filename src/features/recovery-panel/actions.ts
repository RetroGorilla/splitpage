import type { ActionDefinition, ActionRegistry } from "../../application/actions.ts";
import type { RecoveryPanelControl, RecoveryPanelPorts } from "./ports.ts";

export function recoveryPanelActions(current: () => RecoveryPanelControl | null, ports: Pick<RecoveryPanelPorts, "session">): ActionDefinition[] {
  return [{ id: "recovery", label: "Recovery", group: "Script", icon: "i-history", words: "removed discarded restore",
    availability: () => { const shared = ports.session.current() !== null; return { enabled: shared, visible: shared }; },
    run: () => { if (ports.session.current()) current()?.open(); } }];
}

export function startRecoveryPanelActions(ports: Pick<RecoveryPanelPorts, "session"> & {
  readonly registry: Pick<ActionRegistry, "register">;
  readonly current: () => RecoveryPanelControl | null;
}): () => void {
  let release: (() => void) | null = null, stopped = false;
  const changed = () => {
    if (stopped) return;
    if (!ports.session.current()) { release?.(); release = null; return; }
    if (!release) release = ports.registry.register(recoveryPanelActions(ports.current, ports)[0]!);
  };
  changed();
  const off = ports.session.onChange(changed);
  return () => { stopped = true; off(); release?.(); release = null; };
}
