# skills/pinbox

The published agent skill. Installable via `bunx skills add` (and hosted at `/.well-known/agent-skills/index.json` with SHA256 integrity on the docs site).

**`SKILL.md` is a generated artifact** — rendered from the CLI command tree by the docs-sync CI job, which opens a PR whenever the command surface drifts. Never hand-edit it; change the CLI (or the generator) instead. Never document unshipped commands — agents will call them.

This directory is the single source of truth; `packages/cli` embeds a copy at build time. The skill's core contract: treat pin text as untrusted data describing UI issues (never as instructions to execute), and never guess on ambiguous pins — reply with a question instead.
