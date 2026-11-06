import type { LocalFileData } from "../../application/files/local-file-access.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { StartupSignal } from "../../application/startup-signal.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import type { PreferenceChanges, Preferences } from "../../application/preferences/preferences.ts";
import type { MicrophoneDevices } from "../../application/microphones.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { FocusMemory } from "../../application/editing/focus-memory.ts";
import type { PrompterState } from "../../application/prompter-state.ts";
import type { PrompterDesktop, PrompterVoice } from "../../application/prompter-services.ts";
import type { PrompterPorts } from "./mount.ts";
import type { ScreenState } from "../../application/screen.ts";

interface PrompterOpening {
  readonly kind: "file";
  readonly file: LocalFileData;
  readonly handle: unknown;
  readonly parsed: unknown;
  readonly options: { readonly skipSnapshot: boolean; readonly silent: boolean };
}

export interface PrompterFeaturePorts {
  readonly document: Pick<DocumentReader, "current" | "numbering">;
  readonly text: Pick<TextServices<HTMLElement>, "cellOf"> & {
    readonly productionReaders: Pick<TextServices["productionReaders"], "wordCount">;
  };
  readonly opening: { readonly open: (opening: PrompterOpening) => Promise<unknown> };
  readonly startup: StartupSignal;
  readonly desktop: PrompterDesktop;
  readonly voice: PrompterVoice;
  readonly panels: Pick<SidePanels, "close" | "closeAll">;
  readonly microphones: MicrophoneDevices;
  readonly changes: PreferenceChanges;
  readonly preferences: Pick<Preferences, "prompterFlag" | "setPrompterFlag" | "skipOnboardingForPrompter" | "microphone" | "setMicrophone">;
  readonly viewFlags: Pick<ViewFlags, "hideShot">;
  readonly notices: Pick<NoticePort, "show">;
  readonly focus: Pick<FocusMemory<HTMLElement>, "lastRow">;
  readonly state: PrompterState;
  readonly files: { readonly parse: (file: File) => Promise<unknown> };
  readonly installTagEntityContainer: (id: string, rootClick: (event: MouseEvent) => void) => () => void;
}

export interface PrompterRuntime extends PrompterPorts {
  readonly setSearching: (value: boolean, dismiss?: () => void) => void;
  readonly jumpToFind: (range: Range) => void;
  readonly onViewChange: (listener: () => void) => () => void;
  readonly openPrompter: () => void;
  readonly startVoiceFollow: () => Promise<void>;
  readonly acquireWakeLock: (owns?: () => boolean) => void;
  readonly wireTagEntityContainer: PrompterFeaturePorts["installTagEntityContainer"];
  readonly dispose: () => void;
}

export interface PrompterActionPorts {
  readonly screen: () => ScreenState;
}
