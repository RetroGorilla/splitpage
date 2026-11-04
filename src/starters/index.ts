import toCamera from "./to-camera.json" with { type: "json" };
import interview from "./interview.json" with { type: "json" };
import thirtySecondSpot from "./thirty-second-spot.json" with { type: "json" };
import longDemo from "./long-demo.json" with { type: "json" };

export interface Starter {
  id: string;
  name: string;
  desc: string;
  state: typeof toCamera | typeof interview | typeof thirtySecondSpot | typeof longDemo;
}
export const STARTERS: Starter[] = [
  { id: "to-camera", name: "To-camera video", desc: "Hook, intro, scenes, call to action.", state: toCamera },
  { id: "interview", name: "Interview", desc: "Questions on the right, cutaways on the left.", state: interview },
  { id: "spot-30", name: "30-second spot", desc: "Six timed beats with a packshot.", state: thirtySecondSpot }
];

export const LONG_DEMO: Starter = {
  id: "long-demo", name: "Long demo", desc: "Thirty beats, every feature in use.", state: longDemo
};

export function starterById(id: string): Starter | null {
  for (const starter of STARTERS) {
    if (starter.id === id) return starter;
  }
  if (id === LONG_DEMO.id) return LONG_DEMO;
  return null;
}
