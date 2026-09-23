/* The starter scripts the New Tab page offers (issue #144).
 *
 * Each one is a whole document in src/starters/, stored exactly as
 * migrateRows() leaves it — ids, statuses, the production registry and the
 * b-roll records all already in place — so opening one changes nothing
 * about it but the identity migrateRows mints for it. That is not a style
 * preference: a starter that migration or the b-roll list's first read
 * rewrote would open as an edit nobody made. src/test/starters.test.mjs is
 * what holds them to it, and it is also why none of them carries a docId:
 * like seed-state.json, every copy has to be a document of its own.
 *
 * Bundled rather than inlined by build.mjs the way seed-state.json is. The
 * seed has to sit in #state-data because a saved page reads its document
 * back out of that element; a starter is only ever read by this code, so
 * esbuild's JSON loader putting it into the one inlined bundle keeps the
 * shipped index.html a single self-contained file with no marker to add.
 * The import attribute is what lets `node --test` import this module as
 * well.
 *
 * Nothing here touches the DOM or the document: data, and the lookup. */
import toCamera from "../starters/to-camera.json" with { type: "json" };
import interview from "../starters/interview.json" with { type: "json" };
import thirtySecondSpot from "../starters/thirty-second-spot.json" with { type: "json" };

/* In the order the page lays them out, after Blank script. `desc` is the
   card's one line. */
export var STARTERS = [
  { id: "to-camera", name: "To-camera video", desc: "Hook, intro, sections, call to action.", state: toCamera },
  { id: "interview", name: "Interview", desc: "Questions on the right, cutaways on the left.", state: interview },
  { id: "spot-30", name: "30-second spot", desc: "Six timed beats with a packshot.", state: thirtySecondSpot }
];

export function starterById(id) {
  for (var i = 0; i < STARTERS.length; i++) {
    if (STARTERS[i].id === id) return STARTERS[i];
  }
  return null;
}
