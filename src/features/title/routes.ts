import { titleCommand } from "../../application/commands/title.ts";
import type { Command, CommandOutcome } from "../../application/session/document-session.ts";

export interface TitleRoutePorts {
  readonly run: (command: Command) => CommandOutcome;
  readonly current: () => string | null;
  readonly pageTitle: () => void;
}

export interface TitleRoutesMount {
  readonly main: HTMLInputElement;
  readonly writer: HTMLInputElement;
  readonly ports: TitleRoutePorts;
}

export interface TitleRoutes {
  readonly dispose: () => void;
}

export function mountTitleRoutes(mount: TitleRoutesMount): TitleRoutes {
  const ports = mount.ports;
  let open = true;

  function take(input: HTMLInputElement): boolean {
    const current = ports.current();
    if (current === null) return false;
    const outcome = ports.run(titleCommand(input.value));
    if (outcome.kind === "applied" || outcome.kind === "committed") return true;
    if (outcome.kind === "noop") return false;
    input.value = current;
    if (outcome.kind === "failed") throw outcome.error;
    return false;
  }

  function onMainInput(): void {
    if (take(mount.main)) ports.pageTitle();
  }

  function onWriterInput(): void {
    if (take(mount.writer)) mount.main.value = mount.writer.value;
  }

  mount.main.addEventListener("input", onMainInput);
  mount.writer.addEventListener("input", onWriterInput);

  return {
    dispose(): void {
      if (!open) return;
      open = false;
      mount.main.removeEventListener("input", onMainInput);
      mount.writer.removeEventListener("input", onWriterInput);
    }
  };
}
