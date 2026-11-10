import { bWriterBindingContext } from "../b-surfaces/writer-page.ts";
import { startStaleProbe } from "./probe.ts";

startStaleProbe(bWriterBindingContext());
