---
"@autono/pinbox-toolbar": minor
---

Agent replies can identify themselves: when a `role:"agent"` thread message carries an `origin` (e.g. `claude:lark-mac-agent` — the wire already allowed it), the card names the agent — "Claude · lark-mac-agent" — instead of the anonymous "Agent" label. Anonymous posts render exactly as before.
