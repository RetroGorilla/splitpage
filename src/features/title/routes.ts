import { titleCommand } from "../../application/commands/title.ts";
import type { CommonDocumentSession } from "../../application/session/document-session.ts";
import { TITLE_FIELD_KEY } from "../../application/editing/buffered-field-key.ts";
import { beatPos } from "../../core/flow/flow.ts";
import { bindBufferedInput } from "../common/buffered-input.ts";
import type { BufferedInputPorts } from "../common/buffered-input.ts";

interface TitleRoutePorts {
  readonly run: CommonDocumentSession["run"];
  readonly current: () => string | null;
  readonly pageTitle: () => void;
}

interface TitleRoutesMount {
  readonly main: HTMLInputElement;
  readonly writer: HTMLInputElement;
  readonly ports: TitleRoutePorts;
  readonly shared?: BufferedInputPorts;
}

export interface TitleRoutes {
  readonly dispose: () => void;
}

export function mountTitleRoutes(mount: TitleRoutesMount): TitleRoutes {
  const ports = mount.ports;
  let open = true;

  if (mount.shared) {
    const bound = bindBufferedInput({
      inputs: [mount.main, mount.writer], key: TITLE_FIELD_KEY, stored: ports.current, changed: ports.pageTitle,
      position: offset => beatPos(TITLE_FIELD_KEY, offset), owns: pos => pos.kind === "beat" && pos.rowId === TITLE_FIELD_KEY
    }, mount.shared);
    return {
      dispose(): void {
        if (open && bound.dispose()) open = false;
      }
    };
  }

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
