import { locationStarted, startLocation } from "../legacy/location-bridge.ts";

if (!locationStarted()) startLocation();
