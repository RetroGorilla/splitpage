import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { commentsIn } from "./source-scan.mjs";
import { checkComments, scanFile, run, commentsFor, commentFree, isScanned, REQUIRED_MARKERS } from "./comment-gate.mjs";
import { configKind } from "./config-comments.mjs";

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
eq("an arithmetic shift is not a heredoc", texts("a.sh", [
  "echo $((1<<x)) # one",
  "(( y = 2 << z )) # two",
  "echo $((16#ff)) ${x}#not $(( (1 << 2) + 1 )) # three",
  "# four"
].join("\n")), ["# one", "# two", "# three", "# four"]);
eq("a here-string is not a heredoc", texts("a.sh", ['jq . <<<"$health" # one', "cat <<< x", "# two"].join("\n")), ["# one", "# two"]);
eq("ANSI-C quoting closes on its unescaped quote", texts("a.sh", [
  "echo $'it\\'s # not' # one",
  "echo $'a\\\\' # two",
  "# three"
].join("\n")), ["# one", "# two", "# three"]);
eq("a PowerShell comment right after a brace is found", texts("a.ps1", [
  "if ($x) { a }#one",
  "function f {#two",
  "$h = @{a=1}#three",
  "Write-Host a#b"
].join("\n")), ["#one", "#two", "#three"]);
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
  const shifts = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo $((1<<x)) $'it\\'s'\n          # after a shift\n";
  eq("a step's arithmetic shift and ANSI-C string do not hide the comments after them", found(".github/workflows/s.yml", shifts), ["# after a shift"]);
}

{
  const steps = (...lines) => ["jobs:", "  a:", "    runs-on: ubuntu-latest", ...lines, ""].join("\n");
  const viaEnv = steps(
    "    env:",
    "      SCRIPT: &script |",
    "        make",
    "        # via an alias",
    "    steps:",
    "      - run: *script"
  );
  eq("a run: given as an alias is read as the step's script, at the anchor's line", located(".github/workflows/alias.yml", viaEnv), ["7 # via an alias"]);
  const twice = steps(
    "    steps:",
    "      - run: &build 'make # once'",
    "      - run: *build"
  );
  eq("an anchored run: used again by an alias is reported once", located(".github/workflows/alias.yml", twice), ["5 # once"]);
  const shellAlias = steps(
    "    steps:",
    "      - shell: &ps pwsh",
    "        run: Write-Host a",
    "      - shell: *ps",
    "        run: |",
    "          <# block #>"
  );
  eq("a shell: given as an alias picks the dialect", found(".github/workflows/alias.yml", shellAlias), ["<# block #>"]);

  const node = steps(
    "    steps:",
    "      - shell: node {0}",
    "        run: |",
    "          const u = \"https://x.test/#a\"; // js line",
    "          /* js block */",
    "          console.log('# not', `# not ${u}`);",
    "      - shell: node",
    "        run: process.exit(0) // short"
  );
  eq("a shell: node step is read as JavaScript, with its lines", located(".github/workflows/js.yml", node), ["7 // js line", "8 /* js block */", "11 // short"]);
  const script = steps(
    "    steps:",
    "      - uses: actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea",
    "        with:",
    "          script: |",
    "            // why",
    "            const { owner } = context.repo; /* block */",
    "            core.info(\"# not\" + `${{ github.sha }}`);",
    "      - uses: actions/github-script@v7",
    "        with:",
    "          script: return 1 // inline",
    "      - uses: some/other-action@v1",
    "        with:",
    "          script: |",
    "            // not JavaScript we run"
  );
  eq("an actions/github-script script: is read as JavaScript, with its lines", located(".github/workflows/js.yml", script), ["8 // why", "9 /* block */", "13 // inline"]);

  const folded = steps(
    "    steps:",
    "      - run: >",
    "          echo one",
    "          echo two",
    "",
    "          # folded comment",
    "      - run: \"echo a",
    "          # double-quoted comment\"",
    "      - run: 'echo ''a''",
    "          # single-quoted comment'",
    "      - run: \"echo \\\"x\\\"",
    "          make # after an escape\""
  );
  eq("comments in folded and quoted multi-line run: scalars are reported at their own lines", located(".github/workflows/fold.yml", folded), [
    "9 # folded comment",
    "11 # double-quoted comment",
    "13 # single-quoted comment",
    "15 # after an escape"
  ]);
}

{
  let threw = "";
  try { commentsFor(".github/workflows/bad.yml", "a: [1, 2\nb: c\n"); } catch (e) { threw = e.message; }
  check("a YAML file that does not parse is an error, not a pass", threw.startsWith("cannot parse .github/workflows/bad.yml:"), threw);
}

{
  const job = (runsOn, steps) => ["jobs:", "  a:", `    runs-on: ${runsOn}`, "    steps:", ...steps, ""].join("\n");
  const blockThenComment = ["      - run: |", "          <# it's a PowerShell block #>", "          Write-Host x # after"];
  const shellError = (text) => { try { commentsFor(".github/workflows/m.yml", text); return ""; } catch (e) { return e.message; } };

  const matrix = shellError(job("${{ matrix.os }}", blockThenComment));
  check("an expression runner with PowerShell-only syntax and no shell: is refused, not read as bash", matrix.includes(".github/workflows/m.yml:6: cannot tell whether this run: step is bash or PowerShell"), matrix);
  eq("the same step with shell: pwsh is read as PowerShell", found(".github/workflows/m.yml", job("${{ matrix.os }}", [...blockThenComment, "        shell: pwsh"])), ["<# it's a PowerShell block #>", "# after"]);
  eq("an expression runner whose script reads the same either way is scanned", found(".github/workflows/m.yml", job("${{ matrix.os }}", ["      - run: npm ci # why"])), ["# why"]);
  eq("an expression runner with no comment at all passes", found(".github/workflows/m.yml", job("${{ matrix.os }}", ["      - run: npm ci"])), []);
  eq("a runner group's labels are read", found(".github/workflows/m.yml", job("{ group: big, labels: [windows-2022] }", ["      - run: '<# block #>'"])), ["<# block #>"]);
  check("a runner group with no labels is unknown", shellError(job("{ group: big }", blockThenComment)).includes("cannot tell"));
  eq("a self-hosted Linux runner is bash", found(".github/workflows/m.yml", job("[self-hosted, linux]", ["      - run: |", "          cat <<EOF", "          # heredoc text", "          EOF"])), []);
  check("a self-hosted runner with no OS label and a bash heredoc is refused", shellError(job("[self-hosted, x64]", ["      - run: |", "          cat <<EOF", "          # heredoc text", "          EOF"])).includes("cannot tell"));
  eq("defaults.run.shell settles an expression runner", found(".github/workflows/m.yml", "defaults:\n  run:\n    shell: pwsh\n" + job("${{ matrix.os }}", blockThenComment)), ["<# it's a PowerShell block #>", "# after"]);
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
  const dockerfiles = ["Dockerfile", "Dockerfile.prebuilt", "Dockerfile-dev", "Dockerfile_dev", "app.Dockerfile", "web.dockerfile", "docker/Dockerfile"];
  const composes = ["docker-compose.yml", "docker-compose.yaml", "docker-compose.override.yml", "compose.yml", "compose.yaml", "deploy/compose.prod.yaml"];
  const neither = ["Dockerfile.md", "docs/Dockerfile-notes.txt", "Dockerfiles/build.sh", "mycompose.yml", "desktop/electron-builder.yml"];
  eq("every Dockerfile name is scanned as a Dockerfile and comment-free", dockerfiles.map((p) => [configKind(p), commentFree(p)]), dockerfiles.map(() => ["dockerfile", true]));
  eq("every compose file name is scanned as YAML and comment-free", composes.map((p) => [configKind(p), commentFree(p)]), composes.map(() => ["yaml", true]));
  eq("look-alikes are neither", neither.map((p) => [configKind(p) === "dockerfile", commentFree(p)]), neither.map(() => [false, false]));
}
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
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "on: push\njobs:\n  a:\n    runs-on: ${{ matrix.os }}\n    steps:\n      - run: |\n          <# it's #>\n          x # y\n");
  const ambiguous = runIn(repo, "check");
  check("a step whose shell cannot be told fails the gate and says what to set", ambiguous.code === 1 && ambiguous.err.includes("set shell:"), ambiguous.err);
}

rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
