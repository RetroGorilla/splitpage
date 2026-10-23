export interface SidePanels {
  readonly registerPanel: (id: string, closed: () => void) => () => void;
  readonly registerPage: (id: string, close: () => void) => () => void;
  readonly open: (id: string) => void;
  readonly close: (id: string) => void;
  readonly closeAll: () => void;
  readonly sync: () => void;
  readonly applyWidth: (id: string, width: number) => void;
}
