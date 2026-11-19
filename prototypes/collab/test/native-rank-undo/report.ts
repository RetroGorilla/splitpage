import { OPTIONS } from "../../src/native-rank-undo/variants.ts";
import type { RankOption } from "../../src/native-rank-undo/variants.ts";
import { surveyE10, surveyE11 } from "./survey.ts";

// why: prints the generated-set tables in RESULT.md; `node test/native-rank-undo/report.ts [options] [mixed] [doubled]`
const options = (process.argv[2] ?? OPTIONS.join(",")).split(",") as RankOption[];
const size = Number(process.argv[3] ?? 600), twins = Number(process.argv[4] ?? 200);
for (const option of options) {
  const e10 = surveyE10(option);
  console.log(JSON.stringify({
    option, e10: { table: e10.table, outcomes: e10.outcomes.join(""), tally: e10.tally },
    mixed: surveyE11(option, size, false), doubled: surveyE11(option, twins, true),
    mixedOwn: surveyE11(option, size, false, true), doubledOwn: surveyE11(option, twins, true, true)
  }));
}
