import { resolvePersonColor } from "../../../core/document/person-colors.ts";
import type { PersonColorLookup } from "../../../core/document/person-colors.ts";
import { cleanAuthorName } from "../../../core/document/people.ts";
import { preferences } from "../preferences-owner.ts";
import { documentReader } from "./document.ts";

export const personColors: PersonColorLookup = {
  personColor: (seed) => {
    const doc = documentReader.current();
    const colors: unknown = doc && doc.personColors;
    return resolvePersonColor(seed, {
      self: cleanAuthorName(preferences().commentAuthor()),
      selfColor: preferences().myColor(),
      doc: colors && typeof colors === "object" ? colors as Readonly<Record<string, unknown>> : null
    });
  }
};
