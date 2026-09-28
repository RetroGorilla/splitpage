# Security

## Reporting a vulnerability

Please report it privately, not in a public issue: on the repository's
**Security** tab choose **Report a vulnerability**. Include what you found,
how to reproduce it, and which version or deployment it affects.

You'll get an acknowledgement, and a fix or a decision, as soon as the
maintainer can manage; this is a one-person project, so please allow a few
days for a first reply.

## What is supported

Only the latest release. Fixes are not back-ported.

## Deploying safely

The document server has **no login of its own by design**: put it behind
Cloudflare Access or a VPN, and never expose its port to the internet
directly. [DEPLOY.md](DEPLOY.md) covers this, including what `JOIN_PIN` is
and is not for.

The Windows installers are not code-signed yet, so Windows SmartScreen will
warn on first run. Download them only from the releases page, and check the
file against `SHA256SUMS.txt` published with the release.
