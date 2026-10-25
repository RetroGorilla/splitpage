import type { ShotHiding } from "../../../application/shot-hiding.ts";
import { shotHiding as owner } from "../../../legacy/shot-hiding-bridge.ts";

export const shotHiding: Pick<ShotHiding, "reveal"> = {
  reveal: (id) => owner().reveal(id)
};
