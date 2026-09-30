import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { commentsIn } from "./source-scan.mjs";
import { checkComments, scanFile, run, commentsFor, commentFree, isScanned, REQUIRED_MARKERS } from "./comment-gate.mjs";

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

const found = (path, text) => commentsFor(path, text).map((c) => c.text);
const located = (path, text) => scanFile(path, text).map((c) => `${c.line} ${c.text}`);

console.log("\nYAML:\n");

eq("YAML comments are found; quoted, URL and block-scalar hashes are not", found("docker-compose.yml", [
  "# lead",
  "name: x # trailing",
  "url: https://example.test/a#frag",
  "single: '# not'",
  "double: \"# not\"",
  "plain: a#b",
  "notes: | # header",
  "  # a heading in a block scalar",
  "  text",
  "# end"
].join("\n")), ["# lead", "# trailing", "# header", "# end"]);
eq("a run: key outside a workflow is not read as shell", found("docker-compose.yml", "run: |\n  # not shell here\n"), []);
eq("issue-template Markdown inside a block scalar is not a comment", found(".github/ISSUE_TEMPLATE/bug.yml", [
  "body:",
  "  - type: markdown",
  "    attributes:",
  "      value: |",
  "        ## What happened",
  "        # also a heading",
  "        Steps: #1, then #2"
].join("\n")), []);

{
  const workflow = [
    "on: push",
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node tools/x.mjs",
    "      - name: script",
    "        run: |",
    "          echo \"# not\" '# not' $# ${#arr[@]} ${x##*/} a#b",
    "          echo ${{ github.sha }}#frag",
    "          jq -e '.a' <<<\"$health\" >/dev/null",
    "          # whole-line",
    "          cat <<EOF",
    "          # inside a heredoc",
    "          EOF",
    "          cmd --flag # trailing",
    "      - run: echo one # yaml comment",
    "      - run: '#!/bin/bash'",
    ""
  ].join("\n");
  eq("a whole-line # inside run: | is a comment, and the traps are not", located(".github/workflows/ci.yml", workflow), [
    "12 # whole-line",
    "16 # trailing",
    "17 # yaml comment",
    "18 #!/bin/bash"
  ]);
}

{
  const windows = [
    "jobs:",
    "  w:",
    "    runs-on: windows-latest",
    "    steps:",
    "      - run: |",
    "          Write-Host \"# not\" `# escaped # powershell",
    "          <# block #>",
    "      - shell: bash",
    "        run: |",
    "          cat <<EOF",
    "          # heredoc text under bash",
    "          EOF",
    "      - shell: cmd",
    "        run: |",
    "          rem batch",
    ""
  ].join("\n");
  eq("the step's shell, else the job's runner, picks the dialect", found(".github/workflows/w.yml", windows), ["# powershell", "<# block #>", "rem batch"]);
  const defaults = "defaults:\n  run:\n    shell: pwsh\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          cat <<EOF\n          # not a heredoc in PowerShell\n          EOF\n";
  eq("defaults.run.shell applies to every step", found(".github/workflows/d.yml", defaults), ["# not a heredoc in PowerShell"]);
}

{
  let threw = "";
  try { commentsFor(".github/workflows/bad.yml", "a: [1, 2\nb: c\n"); } catch (e) { threw = e.message; }
  check("a YAML file that does not parse is an error, not a pass", threw.startsWith(".github/workflows/bad.yml:"), threw);
}

console.log("\nDockerfiles:\n");

{
  const dockerfile = [
    "# syntax=docker/dockerfile:1",
    "# escape=\\",
    "# a comment ends the directives",
    "# check=skip=all",
    "FROM node:22-alpine AS build",
    "  # indented",
    "RUN echo \"# not\" '#' $# https://example.test/#x \\",
    "  # inside a continuation",
    "  && make # trailing",
    "CMD [\"node\", \"#not\"]",
    "HEALTHCHECK --interval=30s CMD node -e \"x#y\" # health",
    "RUN <<EOF",
    "#!/bin/sh",
    "echo \"#\"",
    "# in a RUN heredoc",
    "EOF",
    "COPY <<EOF /etc/app.conf",
    "# file content, not a comment",
    "EOF",
    "ENTRYPOINT exec node server.js"
  ].join("\n");
  const all = commentsFor("Dockerfile", dockerfile);
  eq("leading parser directives are marked as directives", all.filter((c) => c.directive).map((c) => c.text), ["# syntax=docker/dockerfile:1", "# escape=\\"]);
  eq("everything else that is a comment is found, with its line", located("Dockerfile", dockerfile), [
    "1 # syntax=docker/dockerfile:1",
    "2 # escape=\\",
    "3 # a comment ends the directives",
    "4 # check=skip=all",
    "6 # indented",
    "8 # inside a continuation",
    "7 # trailing",
    "11 # health",
    "15 # in a RUN heredoc"
  ]);
  eq("a directive passes only where it is configured for that file", scanFile("Dockerfile", "# syntax=docker/dockerfile:1\nFROM x\n", REQUIRED_MARKERS, { Dockerfile: ["# syntax=docker/dockerfile:1"] }), []);
  eq("and not for another file", scanFile("Dockerfile.prebuilt", "# syntax=docker/dockerfile:1\nFROM x\n", REQUIRED_MARKERS, { Dockerfile: ["# syntax=docker/dockerfile:1"] }).length, 1);
  eq("the same text further down is a comment even when configured", scanFile("Dockerfile", "FROM x\n# syntax=docker/dockerfile:1\n", REQUIRED_MARKERS, { Dockerfile: ["# syntax=docker/dockerfile:1"] }).length, 1);
  eq("Dockerfile.prebuilt and x.dockerfile are Dockerfiles", [found("Dockerfile.prebuilt", "# a\nFROM x\n"), found("web.dockerfile", "# b\nFROM x\n")], [["# a"], ["# b"]]);
}

console.log("\nJSON and tsconfig:\n");

eq("JSONC comments are found; strings and URLs are not", found("tsconfig.base.json", [
  "{",
  "  // line",
  "  \"a\": \"// not\",",
  "  \"b\": \"https://example.test/*x*/\", /* block */",
  "  \"c\": 1",
  "}"
].join("\n")), ["// line", "/* block */"]);
eq("strict JSON has none", found("package.json", '{ "scripts": { "x": "a // b /* c */" } }\n'), []);

console.log("\nwhich files are scanned:\n");

eq("eslint.config.mjs is scanned", isScanned("eslint.config.mjs"), true);
eq("workflow, Docker, compose, eslint and JSON files can never be baselined", [
  ".github/workflows/ci.yml", ".github/dependabot.yml", "Dockerfile", "Dockerfile.prebuilt", "docker-compose.yml", "eslint.config.mjs", "tsconfig.base.json", "package.json"
].map(commentFree), [true, true, true, true, true, true, true, true]);
{
  const listed = checkComments([{ path: ".github/workflows/ci.yml", text: "on: push # why\n" }], { files: { ".github/workflows/ci.yml": ["# why"] } });
  eq("a workflow comment fails even when a baseline lists it", listed.added.length, 1);
}

console.log("\nbuild markers:\n");

{
  const page = "<style>\n/*{{APP_CSS}}*/\n</style>\n<script>\n//{{APP_JS}}\n</script>\n";
  eq("required markers are not counted", scanFile("src/page.html", page), []);
  eq("a second copy of a marker is a comment", scanFile("src/page.html", page + "<script>//{{APP_JS}}\n</script>").map((c) => c.text), ["//{{APP_JS}}"]);
  eq("markers are allowed only where configured", scanFile("other.html", page).length, 2);
  eq("files the gate cannot read return null", scanFile("a.md", "<!-- prose -->\n"), null);
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

{
  const repo = repoWith({
    ".github/workflows/ci.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          # why\n          make\n",
    "Dockerfile": "FROM node:22-alpine\n",
    "tsconfig.json": "{}\n",
    "eslint.config.mjs": "export default [];\n"
  });
  eq("init refuses a comment inside a workflow's run: block", runIn(repo, "init").code, 1);
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n");
  eq("and once the run: comment is gone, init writes an empty baseline", runIn(repo, "init").code, 0);
  for (const [path, text, where] of [
    ["Dockerfile", "FROM node:22-alpine\n# why\n", "Dockerfile:2"],
    ["tsconfig.json", "{\n  // why\n}\n", "tsconfig.json:2"],
    ["eslint.config.mjs", "export default []; // why\n", "eslint.config.mjs:1"],
    [".github/workflows/ci.yml", "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          make\n          # why\n", ".github/workflows/ci.yml:8"]
  ]) {
    const before = readFileSync(join(repo, path), "utf8");
    writeFileSync(join(repo, path), text);
    const r = runIn(repo, "check");
    check(`a comment in ${path} fails at ${where}`, r.code === 1 && (r.err.includes(`new comment ${where} # why`) || r.err.includes(`new comment ${where} // why`)), r.err);
    writeFileSync(join(repo, path), before);
  }
  eq("the bare tree passes again", runIn(repo, "check").code, 0);
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: [push\n");
  const broken = runIn(repo, "check");
  eq("a workflow that does not parse fails the gate", broken.code, 1);
  check("and says which file", broken.err.includes("cannot parse .github/workflows/ci.yml"), broken.err);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
