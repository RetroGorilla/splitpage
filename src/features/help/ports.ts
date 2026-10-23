import type { ActionRegistry } from "../../application/actions.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { SidePanels } from "../../application/side-panels.ts";

export interface TourPause {
  readonly interrupt: () => void;
  readonly offerResume: () => void;
}

export interface HelpControls {
  readonly openHelp: (anchor?: string) => void;
  readonly startTour: () => void;
}

export interface HelpMount extends HelpControls {
  readonly tour: TourPause;
  readonly dispose: () => void;
}

export interface HelpPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly preferences: Pick<Preferences, "tourFinished">;
  readonly viewFlags: Pick<ViewFlags, "setTourOpen">;
  readonly notices: NoticePort;
  readonly sidePanels: Pick<SidePanels, "closeAll">;
}

export interface HelpActionPorts {
  readonly screen: () => ScreenState;
  readonly desktop: () => boolean;
}
