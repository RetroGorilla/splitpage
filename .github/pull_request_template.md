## What and why

<!-- One or two sentences. Link the issue: "Closes #123". -->

## Structure

Answer "none" where the PR moves nothing.

1. Which responsibility moves, and to which owner?
2. Which dependency does it remove, and does it add none pointing up a layer?
3. What can now be tested on its own?
4. What are the loop and `S` figures before and after, from `node tools/dep-report.mjs --legacy-metrics`?

## Checklist

- [ ] One issue per pull request
- [ ] Tests added or updated (`npm test`, plus a browser suite for anything you can see)
- [ ] `npm run lint` passes
- [ ] Suggested CHANGELOG line in this description if what a person sees or does changed (fix PRs don't edit CHANGELOG.md or docs/help.md)
- [ ] `node build.mjs` run, and `sw.js` committed if `VERSION` changed
- [ ] Screenshots attached for UI changes (light and dark)
