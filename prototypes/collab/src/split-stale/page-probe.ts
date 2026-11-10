import { splitStaleContext } from "./page.ts";
import { startStaleProbe } from "./probe.ts";

startStaleProbe(splitStaleContext());
