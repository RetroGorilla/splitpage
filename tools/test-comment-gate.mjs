import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { commentsIn } from "./source-scan.mjs";
import { checkComments, scanFile, run } from "./comment-gate.mjs";

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const texts = (path, text) => commentsIn(path, text).map((c) => c.text);

console.log("\nscripts:\n");

eq("strings, URLs, regexes and templates are not comments", texts("a.js", [
  'const u = "https://example.test/a";',
  "const s = '/* not */';",
  "const r = /\\/\\/|\\/\\*/g;",
  "const d = a / b / c;",
  "const t = `// ${x /* real */} /* no */`;",
  "x = 1; // trailing"
].join("\n")), ["/* real */", "// trailing"]);
eq("an interpreter directive is not a comment", texts("t.mjs", "#!/usr/bin/env node\nrun();\n"), []);
eq("a comment inside an empty argument list is found", texts("a.js", "f(/* here */);\n"), ["/* here */"]);
eq("a comment at the end of the file is found", texts("a.js", "x();\n// last"), ["// last"]);
eq("TypeScript syntax is parsed", texts("a.ts", "type T = { a: string /* x */ };\nconst n = <T>(v: T): T => v;\n"), ["/* x */"]);
eq("a JSDoc block is a comment", texts("a.ts", "/** doc */\nexport function f(): void {}\n"), ["/** doc */"]);

console.log("\nstyles and markup:\n");

eq("CSS strings and url() are not comments", texts("a.css", [
  'a { background: url(http://x.test/a//b.png); }',
  'b::after { content: "/* no */"; }',
  "c { color: red; } /* yes */"
].join("\n")), ["/* yes */"]);
eq("HTML, inline script and inline style comments are found", texts("a.html", [
  "<!-- one -->",
  '<a title="<!-- not -->">x</a>',
  "<style>p { color: red; /* two */ }</style>",
  "<script>var u = 'http://x.test'; // three\n</script>",
  '<script type="application/json">{"a": "// not"}</script>'
].join("\n")), ["<!-- one -->", "/* two */", "// three"]);

console.log("\nshell, PowerShell and batch:\n");

eq("shell comments respect quoting and parameter expansion", texts("a.sh", [
  "#!/bin/sh",
  "# lead",
  'echo "# not" \'# not\' $# ${#arr[@]} a#b',
  "cmd # trailing",
  "cat <<EOF",
  "# inside a heredoc",
  "EOF",
  "cat <<-'END'",
  "\t# also inside",
  "\tEND",
  "# after"
].join("\n")), ["# lead", "# trailing", "# after"]);
eq("PowerShell block, line and here-string handling", texts("a.ps1", [
  "<# block",
  "#>",
  '$a = "# not" # yes',
  "$h = @\"",
  "# inside a here-string",
  "\"@",
  "Write-Host `# escaped"
].join("\n")), ["<# block\n#>", "# yes"]);
eq("batch REM and :: lines", texts("a.bat", "@echo off\nrem one\n:: two\necho rem not\nREM\n"), ["rem one", ":: two", "REM"]);

console.log("\nbuild markers:\n");

{
  const page = "<style>\n/*{{APP_CSS}}*/\n</style>\n<script>\n//{{APP_JS}}\n</script>\n";
  eq("required markers are not counted", scanFile("src/page.html", page), []);
  eq("a second copy of a marker is a comment", scanFile("src/page.html", page + "<script>//{{APP_JS}}\n</script>").map((c) => c.text), ["//{{APP_JS}}"]);
  eq("markers are allowed only where configured", scanFile("other.html", page).length, 2);
  eq("files the gate cannot read return null", scanFile("a.json", "{}"), null);
}

console.log("\ncheckComments():\n");

{
  const baseline = { files: { "src/js/a.js": ["// kept"] } };
  eq("a baselined comment passes wherever it moved", checkComments([{ path: "src/js/a.js", text: "\n\n\nx(); // kept\n" }], baseline).added, []);
  const swapped = checkComments([{ path: "src/js/a.js", text: "// other\n" }], baseline);
  eq("a replaced comment is new even though the count is equal", swapped.added.map((a) => a.text), ["// other"]);
  eq("and the replaced one is stale", swapped.stale.map((s) => s.text), ["// kept"]);
  const doubled = checkComments([{ path: "src/js/a.js", text: "// kept\n// kept\n" }], baseline);
  eq("a duplicated baselined comment is new", doubled.added.length, 1);
  eq("whitespace changes do not matter", checkComments([{ path: "src/js/a.js", text: "//   kept\n" }], baseline).added, []);
  eq("a comment in a new file fails", checkComments([{ path: "src/js/new.js", text: "/* x */\n" }], baseline).added.length, 1);
  const free = checkComments([{ path: "src/core/text/a.ts", text: "// kept\n" }], { files: { "src/core/text/a.ts": ["// kept"] } });
  eq("a comment-free folder ignores its baseline", free.added.length, 1);
  eq("and reports the entry as stale", free.stale.length, 1);
}

console.log("\nrun() over a repository:\n");

const work = mkdtempSync(join(tmpdir(), "splitpage-comment-gate-"));

function repoWith(files) {
  const repo = mkdtempSync(join(work, "repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}

function runIn(repo, mode) {
  const out = [];
  const err = [];
  const code = run({ repo, baselinePath: join(repo, "baseline.json"), mode, print: (l) => out.push(l), printError: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

{
  const repo = repoWith({ "src/js/a.js": "// old\nx();\n", "README.md": "<!-- prose is not scanned -->\n", "node_modules/p/i.js": "// vendor\n" });
  eq("init writes the existing comments", runIn(repo, "init").code, 0);
  eq("the baseline holds only authored source", Object.keys(JSON.parse(readFileSync(join(repo, "baseline.json"), "utf8")).files), ["src/js/a.js"]);
  eq("an unchanged tree passes", runIn(repo, "check").code, 0);

  writeFileSync(join(repo, "src/js/a.js"), "// old\nx(); // new\n");
  const added = runIn(repo, "check");
  eq("a new comment fails", added.code, 1);
  check("the new comment is located", added.err.includes("src/js/a.js:2 // new"), added.err);
  eq("prune will not absorb a new comment", runIn(repo, "prune").code, 1);

  writeFileSync(join(repo, "src/js/a.js"), "x();\n");
  const stale = runIn(repo, "check");
  eq("a removed comment left in the baseline fails", stale.code, 1);
  eq("prune removes it", runIn(repo, "prune").code, 0);
  eq("the check then passes", runIn(repo, "check").code, 0);

  mkdirSync(join(repo, "src/core/text"), { recursive: true });
  writeFileSync(join(repo, "src/core/text/runs.ts"), "export const a = 1; // no\n");
  eq("a comment in a migrated folder fails", runIn(repo, "check").code, 1);
}

{
  const repo = repoWith({ "src/features/x/v.ts": "// no\n" });
  eq("init refuses to baseline a comment-free folder", runIn(repo, "init").code, 1);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
