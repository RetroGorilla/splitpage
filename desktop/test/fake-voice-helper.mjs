const mode = process.env.FAKE_VOICE_MODE || "listen";
const text = process.env.FAKE_VOICE_TEXT || "hello world";
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (mode === "no-recognizer") {
  say({ type: "error", code: "no-recognizer" });
  process.exit(2);
}
if (process.env.FAKE_VOICE_DEVICE) say({ type: "device", name: process.env.FAKE_VOICE_DEVICE });
if (mode === "stubborn") {
  say({ type: "start", lang: "en-US" });
  process.stdin.resume();
  process.stdin.on("end", () => { });
  setInterval(() => {}, 1000);
} else {
  say({ type: "start", lang: "en-US" });
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
