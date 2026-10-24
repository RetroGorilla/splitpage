import { sidePanels } from "../../../legacy/panels-bridge.ts";

export const panelControl = {
  open: (id: string) => sidePanels().open(id),
  close: (id: string) => sidePanels().close(id),
  closeAll: () => sidePanels().closeAll()
};
