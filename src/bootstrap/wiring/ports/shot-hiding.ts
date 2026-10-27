import type { ShotHiding } from "../../../application/shot-hiding.ts";
import { shotHiding as owner } from "../shot-hiding.ts";

export const shotHiding: Pick<ShotHiding, "reveal"> = {
  reveal: (id) => owner().reveal(id)
};
