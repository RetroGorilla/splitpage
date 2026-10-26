import type { ActionRegistry } from "../../application/actions.ts";
import type { ExportRegistry } from "../../application/export/registry.ts";
import type { CellSelectionOwner } from "../common/cell-selection.ts";

export interface CommandMenuControls {
  readonly commandMenuOpen: () => boolean;
  readonly openCommandMenu: () => boolean;
  readonly closeCommandMenu: (restore?: boolean) => void;
}

export interface CommandMenuMount extends CommandMenuControls {
  readonly dispose: () => void;
}

export interface CommandMenuPorts {
  readonly actions: Pick<ActionRegistry, "invoke" | "list">;
  readonly exports: Pick<ExportRegistry, "exporters">;
  readonly selection: Pick<CellSelectionOwner, "remember" | "forget" | "paintedEpoch" | "resolve">;
  readonly screen: {
    readonly askingFromLauncher: <T>(read: () => T) => T;
    readonly launcherShown: () => boolean;
  };
  readonly exportActionName: (action: string) => string;
  readonly exportActionReason: (action: string) => string;
  readonly runExportAction: (action: string) => void;
  readonly fileMenuOpen: () => boolean;
  readonly refreshFileMenu: () => void;
}
