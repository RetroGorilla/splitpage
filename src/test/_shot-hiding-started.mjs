import "./_preferences-started.mjs";
import { legacyShotHidingPorts, shotHidingStarted, startShotHiding } from "../legacy/shot-hiding-bridge.ts";

if (!shotHidingStarted()) startShotHiding(legacyShotHidingPorts({ start: setTimeout, stop: clearTimeout }));
