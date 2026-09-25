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
import longDemo from "../starters/long-demo.json" with { type: "json" };

/* In the order the page lays them out, after Blank script. `desc` is the
   card's one line. */
export var STARTERS = [
  { id: "to-camera", name: "To-camera video", desc: "Hook, intro, sections, call to action.", state: toCamera },
  { id: "interview", name: "Interview", desc: "Questions on the right, cutaways on the left.", state: interview },
  { id: "spot-30", name: "30-second spot", desc: "Six timed beats with a packshot.", state: thirtySecondSpot }
];

/* The long demo (#215): thirty scenes of one believable video, with every
   feature in use somewhere — each scene status, every tag category, b-roll
   shot and not, comments (one resolved), stage directions, set read times,
   a target the script runs over, video links in a gallery — so it shows
   what a real-length script looks like and doubles as a manual test
   script. Not a card: the New Tab page offers it as a link under the
   cards, and the command menu as "Open the long demo". Opened the same
   way a starter is, as a new untitled copy with no file.

   Written by tools/make-long-demo.mjs rather than by hand; edit the
   scenes there and run it. It is kept apart from the seed on purpose: the
   3-scene seed-state.json is also the pristine-seed gate (invariant #30). */
export var LONG_DEMO = {
  id: "long-demo", name: "Long demo", desc: "Thirty scenes, every feature in use.", state: longDemo
};

export function starterById(id) {
  for (var i = 0; i < STARTERS.length; i++) {
    if (STARTERS[i].id === id) return STARTERS[i];
  }
  if (id === LONG_DEMO.id) return LONG_DEMO;
  return null;
}
