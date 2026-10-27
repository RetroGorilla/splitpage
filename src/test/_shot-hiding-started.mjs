import "./_preferences-started.mjs";
import { shotHidingPorts, shotHidingStarted, startShotHiding } from "../bootstrap/wiring/shot-hiding.ts";

if (!shotHidingStarted()) startShotHiding(shotHidingPorts({ start: setTimeout, stop: clearTimeout }));
