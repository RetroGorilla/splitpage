# Contributing

Splitpage is a small project with one maintainer. Issues and pull requests
are welcome; this page is how to make either easy to act on.

## Reporting a bug or asking for something

Open an issue from the templates. For a bug, say what you did, what you
expected, what happened, and where (browser, desktop app, or a hosted server,
and the version from **Help ▸ About**). Security problems go through
[SECURITY.md](SECURITY.md), not an issue.

Issues carry an `area:` label (`ui`, `editor`, `desktop`, `installer`) and a
type (`bug`, `enhancement`, `documentation`, `accessibility`).
`needs-decision` means the maintainer has to choose before anyone builds it.

## Sending a change

1. One issue per pull request, and link it (`Closes #123`).
2. Build and check locally. [README.md](README.md#working-on-the-code) has the
   setup; the short version is:
   ```
   npm ci
   npm run verify
   ```
   `npm run verify` is what CI's fast gate runs, browser suites aside. While
   you work, run the focused checks for what you changed: the table in
   [docs/architecture/testing.md](docs/architecture/testing.md#what-to-run-for-which-change)
   says which, and `npm test -- --only <path>` narrows the unit tests.
   Anything you can see in the app also needs its browser suites:
   `node tools/run-suites.mjs <out-dir> '<regex over full filenames>'` on
   Linux/macOS, `run-tests.ps1 -Only <full name>` on Windows (see
   [`.claude/skills/run-splitpage-app/SKILL.md`](.claude/skills/run-splitpage-app/SKILL.md)).
   CI runs every unit test and the smoke, CSP and persistence suites on the
   pull request; the full browser regression and the platform checks are run
   at milestone and release gates.
3. If what a person sees or does changed, update
   [`docs/help.md`](docs/help.md) and add a line under **Unreleased** in
   [CHANGELOG.md](CHANGELOG.md).
4. Fill in the pull request template. Screenshots for UI changes, light and
   dark.

Words a person reads follow [docs/STYLE.md](docs/STYLE.md).

Commit messages say what changed for a person using the app, in the
imperative ("Help contents: render a heading's formatting"). Reference an
issue number when there is one.

Read the invariants in [HANDOFF.md](HANDOFF.md) before changing saving,
merging, history or the document format; several tests exist only to hold
them in place.

## Releases

`VERSION` is the one place the version lives. See README's
[Building a release](README.md#building-a-release) and the Release workflow.
