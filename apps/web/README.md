# apps/web

The docs/marketing site. A sibling app — deliberately **not** nested inside a package, which would produce stray lockfiles and couple the site's build to a library's.

Responsibilities:

- Documentation and marketing pages.
- **Dogfooding**: the site runs the pinbox toolbar on itself.
- Hosts the skill discovery surface: `/.well-known/agent-skills/index.json` (with SHA256 integrity) plus `llms.txt`.
- Serves the versioned script-tag bundle path referenced in the embed docs.
