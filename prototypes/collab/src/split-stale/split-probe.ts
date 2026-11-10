import { splitReconcileContext } from "../split-reconcile/page.ts";
import { startStaleProbe } from "./probe.ts";

startStaleProbe(splitReconcileContext());
