import type { ActionDefinition } from "../../application/actions.ts";
import { availableUnless, everyOverlayBut } from "../../application/screen.ts";
import type { PrompterActionPorts, PrompterRuntime } from "./ports.ts";

export function prompterActions(owner: () => Pick<PrompterRuntime, "openPrompter"> | null, ports: PrompterActionPorts): ActionDefinition[] {
  return [{
    id: "present",
    label: "Present",
    group: "View",
    icon: "i-play",
    words: "teleprompter prompter autocue read play",
    availability: () => {
      const button = document.getElementById("btn-present");
      const availability = availableUnless(["loading", ...everyOverlayBut("prompter")], ports.screen());
      const mounted = owner() ? availability : { ...availability, enabled: false };
      return button !== null && !button.hidden ? mounted : { ...mounted, visible: false };
    },
    run: () => { owner()?.openPrompter(); }
  }];
}
