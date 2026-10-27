import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { DocumentOpening } from "../../application/transitions/sources.ts";
import type { StartupSignal } from "../../application/startup-signal.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { FocusMemory } from "../../application/editing/focus-memory.ts";
import type { PrompterState } from "../../application/prompter-state.ts";
import type { PrompterDesktop, PrompterVoice } from "../../application/prompter-services.ts";
import type { PrompterPorts } from "./mount.ts";
import type { ScreenState } from "../../application/screen.ts";

export interface PrompterFeaturePorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf"> & {
    readonly productionReaders: Pick<TextServices["productionReaders"], "wordCount">;
  };
  readonly opening: DocumentOpening;
  readonly startup: StartupSignal;
  readonly desktop: PrompterDesktop;
  readonly voice: PrompterVoice;
  readonly place: Pick<DocumentPlace, "serverHomeId">;
  readonly panels: Pick<SidePanels, "close" | "closeAll">;
  readonly preferences: Pick<Preferences, "prompterFlag" | "setPrompterFlag" | "skipOnboardingForPrompter">;
  readonly viewFlags: Pick<ViewFlags, "hideShot">;
  readonly notices: Pick<NoticePort, "show">;
  readonly focus: Pick<FocusMemory<HTMLElement>, "lastRow">;
  readonly state: PrompterState;
  readonly files: { readonly parse: (file: File) => Promise<unknown> };
  readonly installTagEntityContainer: (id: string, rootClick: (event: MouseEvent) => void) => () => void;
}

export interface PrompterRuntime extends PrompterPorts {
  readonly openPrompter: () => void;
  readonly acquireWakeLock: (owns?: () => boolean) => void;
  readonly wireTagEntityContainer: PrompterFeaturePorts["installTagEntityContainer"];
  readonly dispose: () => void;
}

export interface PrompterActionPorts {
  readonly screen: () => ScreenState;
}
