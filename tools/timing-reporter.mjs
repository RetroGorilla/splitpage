import { relative } from "node:path";

export default async function* timingReporter(source) {
  for await (const event of source) {
    const data = event.data;
    if (event.type === "test:complete" && data.file && !data.entryFile && data.details?.duration_ms != null) {
      yield `FILE_TIMING ${JSON.stringify([relative(process.cwd(), data.file).replaceAll("\\", "/"), data.details.duration_ms])}\n`;
    }
  }
}
