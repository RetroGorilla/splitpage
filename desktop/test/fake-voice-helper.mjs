/* desktop/test/fake-voice-helper.mjs: stands in for desktop/voice/listen.ps1
 * (issue #8) wherever there is no Windows recogniser and no microphone — the
 * unit tests in voice-helper.test.mjs, and smoke.mjs through main's
 * SPLITPAGE_TEST_VOICE_HELPER (honoured only under SPLITPAGE_TEST=1).
 *
 * Speaks the same protocol: JSON lines on stdout, and it exits when stdin
 * closes. What it says is chosen by FAKE_VOICE_MODE:
 *
 *   listen (default)  start, then an interim and a final line of
 *                     FAKE_VOICE_TEXT (default "hello world"), then waits
 *   no-recognizer     an error line, then exits 2
 *   junk              lines the parser must drop, then one good final line
 *   crash             start, then exits 3 at once
 *   stubborn          start, then ignores stdin closing (must be killed)
 */
const mode = process.env.FAKE_VOICE_MODE || "listen";
const text = process.env.FAKE_VOICE_TEXT || "hello world";
const say = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

if (mode === "no-recognizer") {
  say({ type: "error", code: "no-recognizer" });
  process.exit(2);
}
if (mode === "stubborn") {
  say({ type: "start", lang: "en-US" });
  process.stdin.resume();
  process.stdin.on("end", () => { /* ignored on purpose */ });
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
