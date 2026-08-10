# tools/security

`scan-introduced-secrets.ts` — gitleaks over **the commits a push or PR introduces**, wired to
`.github/workflows/secret-scan.yml` and required on `main`.

Run it yourself:

```sh
BASE_SHA=$(git rev-parse main) HEAD_SHA=$(git rev-parse HEAD) bun run scan:secrets
```

It uses a local `gitleaks` if one is on `PATH` and the pinned container image otherwise, so CI
(Docker, no gitleaks) and a laptop (`brew install gitleaks`, no daemon running) both work.

Two decisions worth keeping:

- **A range, not the tree.** A full-tree scan re-reports the same historical false positives on
  every single run, and a check that is always yellow is a check people stop reading. Scanning
  only what a branch adds means silence is meaningful, which is what makes it worth blocking a
  merge on.
- **Dismissals are fingerprints.** `.gitleaksignore` holds `commit:path:rule:line`, never a path
  glob or a disabled rule — those silence the next real finding in the same file. Read the match
  before adding a line; a test asserts the shape.

The scan is a floor, not a ceiling. It reads committed history, and only the slice a branch adds —
so it *does* catch a gitignored `.env` that someone force-added, because `git add -f` puts it in a
commit like anything else. What it cannot see is a secret that was never committed (an Actions
secret, a `.env` still sitting untracked in a working copy), one that landed outside the range
being scanned, or one that matches no rule. It also says nothing about whether a match is still
live — gitleaks reports the string, not its validity, so a hit is a rotation job either way.

Push protection, enabled on the repo, is the layer in front: GitHub blocks a recognized credential
at `git push`, before there is any history for this scan to read.
