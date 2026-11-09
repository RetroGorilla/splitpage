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
import type { ScreenState } from "../../application/screen.ts";
import type { ButtonActions } from "../../application/actions.ts";

export interface PrompterPorts {
  readonly disposeRuntime: () => void;
  readonly closePrompter: () => void;
  readonly closeFind: () => boolean;
  readonly stopVoiceFollow: () => void;
  readonly startVoiceFollow: () => void;
  readonly chooseMicrophone: (id: string) => void;
  readonly setPrompterPlaying: (value: boolean) => void;
  readonly setPrompterSpeed: (value: number) => void;
  readonly applyPrompterSize: () => void;
  readonly stepPrompterSpeed: (value: number) => void;
  readonly stepPrompterSize: (value: number) => void;
  readonly updatePrompterStatus: () => void;
  readonly buildPrompterContent: () => void;
  readonly updateVoiceAvailability: () => void;
  readonly cueBeatForCurrentPosition: () => void;
  readonly updateBeatReadout: () => void;
  readonly setPrompterMirror: (value: boolean) => void;
  readonly setPrompterFlip: (value: boolean) => void;
  readonly setPrompterBeatMode: (value: boolean) => void;
  readonly stepBeat: (value: number) => void;
  readonly voiceActive: () => boolean;
  readonly playing: () => boolean;
  readonly isOpen: () => boolean;
  readonly skipShot: () => boolean;
  readonly setSkipShot: (value: boolean) => void;
  readonly mirror: () => boolean;
  readonly flip: () => boolean;
  readonly beatMode: () => boolean;
}

export interface PrompterOpenPorts extends Pick<ButtonActions, "runFromButton"> {
  readonly presentInBrowser: {
    readonly offered: PrompterDesktop["canOpen"];
    readonly onChange: (listener: () => void) => () => void;
  };
}

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
