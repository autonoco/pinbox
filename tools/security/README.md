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

The scan is a floor, not a ceiling. It reads what is *in the diff*, so it cannot see a key pasted
into a GitHub secret, a `.env` that was correctly gitignored and then force-added, or a token
valid at the moment it was committed and rotated after. Push protection (enabled on the repo)
catches the first case at push time; nothing catches the last one but rotation.
