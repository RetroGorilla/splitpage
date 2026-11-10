import { collectLifetimeCounts } from "./counts.ts";
import { readFileSync } from "node:fs";
import type { ProjectionBag } from "../../proj/value.ts";

const directory = process.argv[2];
const input = process.argv[3];
if (!directory || !input) throw new Error("Expected temporary snapshot directory and fixture JSON");
process.stdout.write(JSON.stringify(collectLifetimeCounts(directory, JSON.parse(readFileSync(input, "utf8")) as ProjectionBag)));
