# Splitpage 4.0 refactor

Goal: code that is easy to change in one place without re-testing or
rewriting the sections that depend on it, and that several agents can work
on at once without touching the same files. No plugin system, no SDK.

Sequencing, scope and acceptance are in [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).
`HANDOFF.md` section 5 stays the invariants list until the ledger in
`docs/architecture/invariants.md` exists; absorbed rules are then removed
from section 5 with a pointer to the ledger, so the two never disagree.

## Decisions

| Decision | State |
| --- | --- |
| Branch | `4.0-development`, `main` merged in at least weekly |
| Plugins and SDK | Out of scope |
| TypeScript for new folders, erasable syntax only | Decided |
| ARM64 Windows runtime checks | A device is available; the release checklist row stands as written |
| CI | Fast gates on hosted runners for PRs and the development branch; the full browser regression, Electron smoke, Windows and ARM64 checks run locally at milestone and release gates. Every check is a local script first |
| Comments in workflow YAML | Covered by the no-comment rule; existing ones under the frozen baseline, new explanations go to `docs/` |
