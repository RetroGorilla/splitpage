import fs from "node:fs";

const mode = process.env.FAKE_VOICE_MODE || "listen";
const text = process.env.FAKE_VOICE_TEXT || "hello world";
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const microphones = process.env.FAKE_VOICE_MICROPHONES ? JSON.parse(process.env.FAKE_VOICE_MICROPHONES) : [];
const argv = process.argv.slice(2);
const wanted = argv.indexOf("-Device") !== -1 ? argv[argv.indexOf("-Device") + 1] : "";
if (process.env.FAKE_VOICE_ARGS_LOG) fs.appendFileSync(process.env.FAKE_VOICE_ARGS_LOG, JSON.stringify(argv) + "\n");

if (argv.includes("-List")) {
  if (mode === "list-silent") {
    setInterval(() => {}, 1000);
  } else {
    const junk = [{ id: "x; calc.exe", name: "Bad" }, { id: microphones[0] && microphones[0].id, name: 7 }];
    say({ type: "microphones", list: mode === "list-junk" ? junk.concat(microphones) : microphones });
    process.exit(0);
  }
} else if (mode === "no-recognizer") {
  say({ type: "error", code: "no-recognizer" });
  process.exit(2);
} else {
  const chosen = wanted ? microphones.find((m) => m.id.toLowerCase() === wanted.toLowerCase()) : null;
  if (wanted && !chosen) say({ type: "fallback" });
  if (chosen) say({ type: "device", name: chosen.name });
  else if (process.env.FAKE_VOICE_DEVICE) say({ type: "device", name: process.env.FAKE_VOICE_DEVICE });
  say({ type: "start", lang: "en-US" });
  if (mode === "lost") {
    setTimeout(() => { say({ type: "error", code: "device-lost" }); process.exit(3); }, 300);
  } else if (mode === "stubborn") {
    process.stdin.resume();
    process.stdin.on("end", () => { });
    setInterval(() => {}, 1000);
  } else {
    if (mode === "crash") process.exit(3);
    if (mode === "junk") {
      process.stdout.write("not json\n");
      say({ type: "exec", cmd: "calc.exe" });
      say({ type: "error", code: "<script>" });
      say({ type: "final", text: 42 });
      say({ type: "final", text: text, html: "<b>x</b>", extra: 1 });
    } else {
      say({ type: "interim", text: text.split(" ")[0] });
      say({ type: "final", text: text });
    }
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  }
}
