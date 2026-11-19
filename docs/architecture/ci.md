# Why the CI configuration looks the way it does

Workflow and configuration files carry no comments
([plan](../IMPLEMENTATION-PLAN.md) section 2; `npm run check:comments` enforces
it). A setting whose reason is not visible in the file itself is explained
here, under the file and the step that holds it. [testing.md](testing.md#ci)
lists what each job runs.

## `.github/workflows/ci.yml`

The change classifier reports `code`, `app` and `desktop` separately.
`desktop` is `app` plus any non-prose change under `desktop/test/`, so an edit
to the smoke itself runs the smoke; it decides whether `desktop-smoke` runs.
For non-prose
changes requiring a fresh run, the static checks always run. The five always-run root
shards run when `root_due=true`. On pull requests that means `root_tests=true`
and a fresh tree. The six old-adapter shards run when `old_adapter=true`. Both root
matrices run on every push to `main`, including prose pushes and trees that passed earlier.
The prototype shards run when `collab=true` and the tree needs a fresh run. Only known test-only
paths, the classifier itself, issue templates, Dependabot configuration and
selected non-browser workflows can skip the app build, browser suites and
built-app upload in `checks`. Runtime source, server code, dependencies,
browser tooling, `ci.yml`, `nightly.yml` and unknown paths retain full app
coverage. Unknown or empty diffs also run everything. Renames are expanded
into removed and added paths so moving runtime code into a test folder cannot
hide the runtime change. Test shards retain their own build and stamp check.
A root shard asks the test runner whether its selection includes printed PDF
tests. Only those shards install Chromium and its system dependencies.
`checks` still installs Chromium for the app's browser suites.

Chromium is stored outside the checkout in
`$RUNNER_TOOL_CACHE/splitpage-playwright/$PLAYWRIGHT_VERSION`. Self-hosted
runners reuse that version across checkout cleanup; a version bump selects
a new directory. GitHub-hosted runners still install system dependencies.
Where present, nightly and native Windows workflows use the same versioned
cache layout. No new schedule or runner routing is introduced.

| Where | Why |
| --- | --- |
| `checks` and `tests` jobs, `SPLITPAGE_CHROME_ARGS: --no-sandbox --disable-dev-shm-usage` | Ubuntu 24.04's AppArmor blocks the user namespaces Chromium's sandbox needs. Without these flags the browser dies before it opens a DevTools (CDP) port, and every browser step fails. |
| `changes`, `checks`, `tests`, `collab-tests` and `gate` jobs, `runs-on: ${{ contains(github.event.pull_request.labels.*.name, 'ci-github') && 'ubuntu-latest' \|\| vars.CI_RUNNER \|\| 'ubuntu-latest' }}` | The label `ci-github` is left from when CI ran on self-hosted runners, and now selects the same runner as `CI_RUNNER`. The label's string literal makes the comment gate's runner reading `unknown`, so a comment in these jobs' scripts that reads differently as bash and as PowerShell needs a `shell:` on its step. The repository variable `CI_RUNNER` is `ubuntu-latest`, and `nightly.yml` reads it with no fallback, so set it rather than delete it. The repository is public and has no self-hosted runners; a fork's pull request can edit `runs-on`, so don't register one. `CI_RUNNER` must name a Linux runner: the comment gate reads a `runs-on` expression by its string literals, here `'ubuntu-latest'`, and so scans these jobs' scripts as bash. |
| Tab strip width check | Removed by the maintainer's decision (2026-10-14). It guarded PR #17's bug (editing one tab's title resized every other tab) and cost about 55 s per run; see `ci-audit.md` in the project files. `desktop/tabstrip/` still ships. |
| Node 24 | CI has no separate Node 24 job: `checks`, both root test matrices and the prototype test shards read `.nvmrc`, which pins Node 24.22.1 since the end-of-M5 upgrade. Node 22 stays inside `package.json`'s `engines` for the portable install, which uses the user's own Node, but CI no longer runs it. |
| `checks` job, step `Browser suites for save, typing, undo and export` | Real-app coverage of the four paths a pull request most often breaks, on the same two lanes and port block as the step before it. Save: `19-save-conflict`, `28-autosave`, `185-autosave-every-edit`, `261-import-save-back-late-edit`, `270-save-open-every-surface`, `283-save-status-by-destination`, `285-save-buttons-one-state`. Typing: `06-writer`, `81-draft-edit`, `282-editor-operations`, `289-script-cell-ime`, `595-writer-flow-mode-position`, `596-writer-flow-typing-work`. The two writer guards check visible position in both directions and count redundant text-child replacements, full-host repair scans and unrelated decorations; they use no latency threshold. Undo: `73-undo`, `84-undo-caret`, `267-writer-undo`. Export: `03-exports`, `41-export-polish`, `259-xlsx-export`, `284-exports-from-a-fixture`, `98-export-dialog`. The original 19 passed twice locally on Windows before listing. The two phase-8 guards have focused and full runs recorded in the PR. The known flaky suites (186, 247, 266, 173, 30, 134) are not in it and no suite in it is retried; a suite that turns flaky leaves the list, it is not retried or relaxed. The original step added about 75 s to `checks` (2 min 8 s against about 55 s without it, first hosted run of the pull request that added it); the budget is 6 min. Its logs go to the `suite-logs` artifact in `suites-flows` when it fails. |
| Root test matrices and `checks` | `tests` runs `npm run test:all -- --shard 1/5 --suite=always` through `5/5`. `old-adapter-tests` uses `--suite=old-adapter` with `1/6` through `6/6`. They run in parallel with `checks`. The shared `.github/actions/root-test-setup` action installs tooling and Chromium, builds the app and checks the worker stamp independently in each checkout. `tools/run-tests.mjs` balances each matrix by measured file weights from `tools/test-weights.json`, heaviest first, with a one-second estimate for new files. `fail-fast: false` lets the remaining shards finish after a failure. `tools/test-ci-old-adapter-shards.mjs` verifies in `checks` that the matrices cover every discovered root test exactly once. |
| `collab-tests` matrix, `if: needs.changes.outputs.collab == 'true' && needs.changes.outputs.tested != 'true'` | The collaboration prototype's tests ran as one step of `checks` and took 9.6 of its 12.8 minutes on PR #1644 (3,328 tests). Each shard now runs the prototype's `npm test` command with Node's `--test-shard=<i>/<n>` placed after `--test`: after the file patterns Node reads it as one more pattern and runs every file. Node splits the sorted file list, so the shards together run every prototype test file once. A shard installs only `prototypes/collab`: the tests reach `src/` and `shared/` modules by relative path only, and none of those imports a package. `checks` still installs `prototypes/collab`, because `npm run typecheck` checks `prototypes/collab/tsconfig.json`. The cache paths match `checks` so the shards restore the cache `npm-cache` fills on `main`. `tools/test-ci-collab-shards.mjs` fails when the shard command and `prototypes/collab/package.json`'s `test` script differ. `checks` runs it whenever `collab=true`, so a prototype-only change, which skips the root `tests` shards, still runs it; the root `tools` tests run it too. |
| `desktop-smoke` job, `if: needs.changes.outputs.desktop == 'true' && needs.changes.outputs.tested != 'true'` | The Electron dev-target smoke (`desktop/test/smoke.mjs --only-target dev`, about 600 checks launching real Electron processes under Xvfb) runs on every pull request and every push to `main` whose change touches app or desktop code, unless the same tree already passed. It names `ubuntu-latest` directly, because it needs `sudo apt-get` for Xvfb. It runs in parallel with `checks` and `tests`, so a run lasts as long as the smoke does: 5 min 30 s in the first hosted run (the smoke step 4 min 46 s). The 90-minute timeout is unchanged. |
| `nightly.yml`, jobs `mutants-fast-baseline`, `mutants-fast` and `mutants-fast-report` | The collaboration mutants no longer gate pull requests: their baseline and six shards took about 86 of a pull request run's 140 runner minutes. They run nightly under a 30-minute limit each (one baseline with `--baseline-only --baseline-timeout 1500`, six shards with `--no-baseline --concurrency 4 --fail-on-survivor`), so a survivor is reported the next morning. [testing.md](testing.md#collaboration-mutants-in-ci) records the measurements behind running the baseline once. |
| `gate` | The summary check requires successful classification and the expected result of each job. It requires both root matrices on pushes to `main`, the always-run matrix on other fresh root-test changes, and the old-adapter matrix whenever `old_adapter=true`. Other jobs follow their change flags and the existing tree lookup. Every job that was due must succeed and every job outside the run must be skipped. The gate then lists the workflow jobs with `actions: read` and requires one successful result at the latest attempt of each expected shard. This catches cancellations that GitHub can omit from a matrix aggregate, including a leg cancelled before acquiring a runner. A partial rerun can use earlier successful jobs for legs it did not rerun. Missing, duplicate, failed, cancelled or skipped legs and job-list API errors fail the gate before marker upload. `tools/test-ci-shards.mjs` exercises both gate steps. |
| `on.push` and `concurrency` | Pushes to `hotfix/**` run CI because a hotfix is tagged on its own branch, and the [release gate](#release-gate) needs a passed run of that commit; they never skip the tree check. Every merge to `main` runs CI again on the merged commit, the only run that tests the merged result when the base moved after the pull request's last run (unless the `changes` job finds the same tree already passed, below). A push run classifies only the files its own push changed (`github.event.before` to the new commit), so a docs-only merge skips `checks`. Pull-request runs share a concurrency group per ref and cancel superseded runs. Push runs use their run id in the group, so a later docs-only merge does not cancel an earlier push's code checks. |
| `changes` job, step `Find a passed run of this exact tree`; `gate` job, `ci-passed-tree-<tree>` upload | A pull request's run tests GitHub's trial merge of its branch into the base as the base was when the run started. When nothing else merged since, the merge commit has exactly that tree (the same files), so the push run after the merge would repeat the same checks. Each run whose `checks` and all five `tests` shards succeed, whose `old-adapter-tests`, `collab-tests` shards and `desktop-smoke` succeeded or were not due, uploads a small artifact named `ci-passed-tree-<git tree SHA>`. It asks for 30 days but lives only as long as the repository's artifact retention allows (3 days in October 2026); once it expires, the push run runs everything. On a push to `main`, `tools/ci-tested-tree.mjs --lookup` lists artifacts by that name for the pushed commit's tree and accepts one only from another run of `ci.yml` that concluded `success` and ran on this repository's own branches, not a fork's. A match sets `tested=true`: `checks`, `collab-tests` and `desktop-smoke` skip. Both root matrices still run on the push to `main`. No match, or any API error, runs everything as before. The job needs `actions: read` to list artifacts. A test-only `main` push with no match skips the app build, the `splitpage-app` upload and, unless it changes a non-prose file under `desktop/test/` (the smoke's own files, which run `desktop-smoke` and its own app build), `desktop-smoke` too; a skipped `main` push has no `splitpage-app`; build that commit locally with `node build.mjs` when you need its files. `tools/test-ci-tested-tree.mjs` covers which runs count; `tools/test-ci-shards.mjs` runs the gate scripts against every `tested` value and individual matrix outcomes. |
| `checks` and `tests` jobs and `nightly.yml`, step `Install Chromium`, `--with-deps` only when `runner.environment == 'github-hosted'` | `--with-deps` runs `sudo apt-get`, which the self-hosted runners used until 1 November 2026 couldn't do without a password. |
| `checks` and `tests` jobs, step `Install Chromium` | The runner's `/usr/bin/chromium` is a snap that never opens a debugging port. The step installs Playwright's Chromium (pinned by `PLAYWRIGHT_VERSION`) under `PLAYWRIGHT_BROWSERS_PATH`, finds its `chrome` binary and hands it to the driver as `SPLITPAGE_CHROME`. |
| `checks` job, step `Pick this runner's port block` | Two runners on one machine would start their suite servers on the same ports. The step takes the number at the end of `RUNNER_NAME` (1 when there is none, as in `splitpage-wsl`) and maps it to a block of 100 ports, `(n + 9) % 10 * 100`, passed to `tools/run-suites.mjs` as `--port-base`. Numbers 1 to 10 get blocks 0 to 900; numbers ten apart (1 and 11) share one. Runners that share a machine must get different blocks; `splitpage-unraid-1` and `splitpage-wsl` share block 0 but run on different machines. |
| `desktop-smoke` job, step `Install desktop dependencies` | Runs `npm ci` without an architecture override. Architecture selection is confined to the subsequent Electron binary fetch; desktop/.npmrc has been removed. |
| `desktop-smoke` job, step `Fetch the dev Electron binary` | Runs `npm run fetch-electron`. `desktop/electron-arch.mjs` selects the machine architecture, detecting native Windows ARM64 even under x64 Node emulation, then sets `npm_config_arch` for Electron's installer. Explicit `npm_config_arch` or `ELECTRON_ARCH` wins, in that order; unknown values fail. Electron 45 has no postinstall. |
| `desktop-smoke` job, step `Desktop smoke (dev target)` | Xvfb is started by hand because `xvfb-run` intermittently returns its own cleanup failure as the exit status. The `grep` on Xvfb's stderr drops xkbcomp's harmless unknown-keysym warnings, about 1,700 lines a run. |

### Old shared-document adapter

A pull request runs the old-adapter matrix when it changes the old adapter,
`src/core/`, `shared/`, `src/application/`, the shared-buffer wiring or related
old wiring, a test or support file in the partition, copied prototype oracles,
test-runner or CI code, or package manifests and lockfiles. Unknown diffs run it.
A change confined to `src/adapters/collab/native/` and `tests/adapters/collab/native/`
leaves it skipped. Native tests and tree-wide inventories stay in the always-run
matrix, including guarded subscriptions and commit-time writers. The trial-replica
write and formatting-monitor inventories scan the old adapter and run with its matrix.

`tools/old-adapter-tests.mjs` follows imports through test support and old-specific
wiring. Normal application boot does not move standalone tests into the filtered
matrix. File-based fixtures and computed or conditional loads are a limit of static
import analysis. The classifier covers known fixture paths and runs on deleted test
and support paths conservatively. The explicit boot-fixture list covers tests that
reach the old adapter through the test hook. Pushes to `main` and the unfiltered
nightly root matrix still exercise the full root suite.

### Known limits

- The passed-tree marker `ci-passed-tree-<tree>` is keyed on the tree alone and does not record which jobs ran. A tree first passed by a run that did not need the prototype tests (`collab=false`) can therefore be reused by a later run on the same tree that would have needed them, which then skips them. This predates the `collab-tests` job: the prototype tests were a skipped step of a successful `checks` in the same case.

## `.github/workflows/nightly.yml`

Every browser suite, four lanes, on `CI_RUNNER`, once a day and on demand. The
nightly root matrix runs every unit, desktop and tool test across ten shards. The
collaboration mutants run here too. `mutants-fast-baseline` and `mutants-fast`
(six shards) run every `tests/collab/*-mutants.json` except the slow one, and
`mutants` runs `tests/collab/undo-slow-mutants.json`, too slow for a pull
request; [testing.md](testing.md#collaboration-mutants-in-ci) says which and why.
When the fast set fails, `mutants-fast-report` opens or comments on the issue
"Nightly collaboration mutants failed"; the slow job's report step does the same.
The jobs pass or fail separately.

| Where | Why |
| --- | --- |
| `actions/checkout` with no `ref` | A scheduled run checks out the default branch, `main`. A run started by hand (`gh workflow run nightly.yml --ref <branch>`) tests that branch, so a pull request that changes a suite can be checked with the full nightly before it merges. |
| step `Run the failing suites again one at a time` | Runs only after a failure, on one lane, into `suites-alone`. It never changes the run's result: a suite that failed stays failed. It tells a suite that fails on its own from one that fails only beside three others on the runner's CPUs. |
| steps `Keep the failing suites' output` and `Upload the failing suites' output` | The step log keeps only each suite's RESULT line. The `nightly-failures` artifact holds `failures.txt` and, for each run (`suites`, `suites-alone`), `summary.txt`, the failing suites' logs with each FAIL line and the screenshots those logs name. It is limited to the failing suites to stay small; the repository's artifact retention (3 days) applies. |

## `.github/workflows/release.yml`

The workflow builds what docs/RELEASING.md §3 publishes, from a `v*` tag, on a
GitHub-hosted Windows runner: `node tools/package.mjs` (which builds `index.html`
itself before zipping), then `npm run dist:win` in `desktop/`, then
`SHA256SUMS.txt`. docs/RELEASING.md §3 has the release procedure. A run started by
hand (Actions ▸ Release ▸ Run workflow) builds from any branch and never
drafts a release; the `draft` job runs only for a tag.

| Where | Why |
| --- | --- |
| every `uses:` | Pinned to a full commit SHA, so a moved or compromised tag cannot change what a release runs. The version is not written beside the SHA, because the comment gate allows no comment in `.github/` outside a `run:` script; it is listed here instead. Looked up with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (dereferencing annotated tags): `actions/checkout` v7 `3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/setup-node` v7 `949feb2413d6458794dcd2491c4babbbce0c15c1`, `actions/upload-artifact` v7 `cf430e030ddbb5b0abf93d22962f4752f3646cd9`, `actions/download-artifact` v8 `9000827ccba6bdab643e8b6fd33ac0654aef8333`. `ci.yml` keeps its own pins. |
| `verify-ci` job, `permissions` | The workflow default stays `contents: read`. This job alone adds `actions: read` (artifact and run lookups) and `checks: read` (the `gate` check run). |
| `build` job, `needs: verify-ci` | Nothing builds, and so `draft` never runs, for a commit with no passed CI run. See [Release gate](#release-gate). |
| `build` job, `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` | The installers are unsigned (#81). Without this electron-builder looks for a signing certificate in the runner's store. |
| `build` job, step `Read VERSION and check the tag` | `VERSION` is the single source of truth (`desktop/stage.mjs` checks `desktop/package.json` against it). A tag naming another version would publish files whose names and update checks disagree with it. |
| `build` job, step `Desktop installers (dist:win, with verify-dist)` | `dist:win` runs `stage.mjs`, electron-builder for x64 and arm64, then `verify-dist.mjs`: the architecture checks and the payload extraction that caught 2.0.1's empty ARM64 installer. A mismatch fails the job there. |
| `build` job, step `Collect the release files and their checksums` | Only the per-arch installers are published, not the combined one (docs/RELEASING.md §3). The `sha256sum` output format is the one `desktop/main.ts` reads to check a downloaded update. |
| `draft` job, `permissions` | This job alone grants `contents: write` to `GITHUB_TOKEN`, so it can create a draft release in this repository for review and publication. |

### Release gate

A tag can be pushed on any commit, including one whose CI run failed or never
ran. The `verify-ci` job runs `tools/release-ci-check.mjs` on the tagged commit
(`GITHUB_SHA`) before `build`, and passes only if one of these holds:

1. The commit has a completed, successful `gate` check run (checks API,
   `GET /repos/{owner}/{repo}/commits/{sha}/check-runs?check_name=gate`) from
   GitHub Actions. The check run's own `head_sha` and its linked workflow run's
   `head_sha` must both be that commit, and the run must be of
   `.github/workflows/ci.yml` on this repository, not a fork. `gate` also
   succeeds for a change that was prose only, and for a push whose tree an
   earlier run had already passed, so those commits count too.
2. The commit's tree has a `ci-passed-tree-<tree>` artifact from a successful
   `ci.yml` run, found with `passedRun` from `tools/ci-tested-tree.mjs`. This
   covers a commit that only has a merge-equivalent tree, such as a pull
   request's own run. The artifact expires with the repository's artifact
   retention (3 days in October 2026); the `gate` check run does not.

Both listings are read page by page (100 per page, at most 30 pages, a longer
listing fails), and the artifact lookup still goes through `passedRun`, which
`tools/release-ci-check.mjs` hands a listing that has already been read in full,
so `tools/ci-tested-tree.mjs` and CI's own use of it are unchanged.

Every lookup error fails the check (fail closed), including one on a later page.
An error on the check listing or the gate run's lookup fails the job even if a
marker exists, and the artifact lookup is not tried; only "no `gate` check run
found" or "found, none a success" falls through to the artifact lookup. A
failure is an `::error::` line naming the commit and what was missing.

A run started by hand (`workflow_dispatch`) runs the same check on the dispatched
commit but reports a failure as `::warning::` and succeeds, because it is a dry
run that drafts nothing (the `draft` job runs only for a tag).
`tools/test-release-ci-check.mjs` covers gate success, gate failure, no run found,
the tree artifact, API errors and the tag and dispatch messages. Only the first
real tag proves the token permissions and the live check-run data.

## Desktop packaging (`desktop/electron-builder.yml`)

The configuration that `dist:win` hands to electron-builder is explained,
setting by setting, in [desktop-build.md](desktop-build.md): what goes into the
asar and what is staged beside it, why both architectures are pinned, and why
the NSIS payload is a ZIP with differential packaging off.

## `.github/dependabot.yml`

Dependency updates arrive as pull requests, so they run through the same CI
as any other change. They are weekly and grouped, so a week's updates are
one pull request per area rather than a stream.

| Entry | Why |
| --- | --- |
| npm, `/desktop` | The Electron shell and its installer builder. Major Electron releases change Chromium and the security defaults, so they are read, not merged on green. |
