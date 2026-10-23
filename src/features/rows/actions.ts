import type { ActionDefinition } from "../../application/actions.ts";

export interface RowControls {
  readonly reveal: (rowId: string) => void;
}

export function rowActions(rows: RowControls): ActionDefinition[] {
  return [
    {
      id: "reveal-row",
      label: "Show scene",
      group: "Open",
      availability: () => ({ enabled: true, visible: false }),
      run: (_source, input) => {
        if (typeof input !== "string") throw new TypeError("reveal-row needs a scene id");
        rows.reveal(input);
      }
    }
  ];
}
