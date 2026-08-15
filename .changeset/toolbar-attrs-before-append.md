---
"@autono/pinbox-toolbar": patch
---

Vite plugin: set `hub`/`token` attributes before inserting the toolbar element. The injected bootstrap used to append first, so `connectedCallback` started configless and every pin submit was silently dropped — the toolbar rendered but never connected. The element also rescues itself now: attributes (or a `configure()` call) that first complete a config after insertion start the transport, deferred to end-of-tick so a config set attribute-by-attribute is read whole, with a lifetime guard so a start that spans a disconnect can neither connect a detached element nor double-connect a reconnected one.
