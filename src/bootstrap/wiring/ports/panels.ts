import { sidePanels } from "../../../legacy/panels-bridge.ts";

export const writerPanels = sidePanels;

export const panelControl = {
  registerPanel: (id: string, closed: () => void) => sidePanels().registerPanel(id, closed),
  sync: () => sidePanels().sync(),
  open: (id: string) => sidePanels().open(id),
  close: (id: string) => sidePanels().close(id),
  closeAll: () => sidePanels().closeAll()
};
