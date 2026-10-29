import { resolvePersonColor } from "../../../core/document/person-colors.ts";
import type { PersonColorLookup } from "../../../core/document/person-colors.ts";
import { cleanAuthorName } from "../../../core/document/people.ts";
import { preferences } from "../../../legacy/preferences-bridge.ts";
import { currentDocument } from "../session-owner.ts";

export const personColors: PersonColorLookup = {
  personColor: (seed) => {
    const doc = currentDocument();
    const colors: unknown = doc && doc.personColors;
    return resolvePersonColor(seed, {
      self: cleanAuthorName(preferences().commentAuthor()),
      selfColor: preferences().myColor(),
      doc: colors && typeof colors === "object" ? colors as Readonly<Record<string, unknown>> : null
    });
  }
};
