import type { ActionDefinition } from "../../application/actions.ts";
import type { PrompterFeaturePorts, PrompterRuntime } from "../../features/prompter/ports.ts";
import { startPrompter } from "../../features/prompter/prompter.js";
import { prompterActions as definitions } from "../../features/prompter/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader } from "./ports/document.ts";
import { text } from "./ports/text.ts";
import { opening } from "./ports/transitions.ts";
import { startup } from "./ports/startup.ts";
import { prompterDesktop, prompterVoice } from "./ports/desktop.ts";
import { panelControl } from "./ports/panels.ts";
import { prompterPreferences, prompterView } from "./ports/preferences.ts";
import { notices } from "./ports/effects.ts";
import { focus } from "./ports/editing.ts";
import { screen } from "./ports/screen.ts";
import { parseProjectFileState } from "../../adapters/formats/project-file.ts";
import { createTagEntityContainer } from "./production.ts";
import {
  prompterIsOpen, prompterIsPlaying, prompterSkipsShot, voiceIsFollowing,
  setPrompterOpen, setPrompterPlayingFlag, setPrompterSkipShot, setVoiceFollowing
} from "../../application/prompter-state.ts";

const prompter = owned<PrompterRuntime>();

export function mountPrompterRuntimeFeature(): PrompterRuntime {
  return prompter.replace(() => {
    const ports: PrompterFeaturePorts = {
      document: documentReader, text, opening, startup,
      desktop: prompterDesktop, voice: prompterVoice,
      panels: panelControl, preferences: prompterPreferences, viewFlags: prompterView,
      notices, focus, files: { parse: parseProjectFileState },
      state: {
        isOpen: prompterIsOpen, isPlaying: prompterIsPlaying, skipsShot: prompterSkipsShot,
        voiceFollowing: voiceIsFollowing, setOpen: setPrompterOpen, setPlaying: setPrompterPlayingFlag,
        setSkipShot: setPrompterSkipShot, setVoiceFollowing
      },
      installTagEntityContainer: createTagEntityContainer
    };
    return startPrompter(ports);
  });
}

export const stopPrompterRuntimeFeature = prompter.stop;

export function prompterControls(): PrompterRuntime | null {
  return prompter.owner();
}

export function prompterActions(): ActionDefinition[] {
  return definitions(prompter.owner, { screen });
}
