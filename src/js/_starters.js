import toCamera from "../starters/to-camera.json" with { type: "json" };
import interview from "../starters/interview.json" with { type: "json" };
import thirtySecondSpot from "../starters/thirty-second-spot.json" with { type: "json" };
import longDemo from "../starters/long-demo.json" with { type: "json" };

export var STARTERS = [
  { id: "to-camera", name: "To-camera video", desc: "Hook, intro, sections, call to action.", state: toCamera },
  { id: "interview", name: "Interview", desc: "Questions on the right, cutaways on the left.", state: interview },
  { id: "spot-30", name: "30-second spot", desc: "Six timed beats with a packshot.", state: thirtySecondSpot }
];

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
