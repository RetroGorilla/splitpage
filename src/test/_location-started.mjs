import { locationStarted, startLocation } from "../bootstrap/wiring/location-owner.ts";

if (!locationStarted()) startLocation();
