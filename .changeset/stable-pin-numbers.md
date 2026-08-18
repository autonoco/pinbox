---
"@autono/pinbox-core": minor
"@autono/pinbox-toolbar": minor
---

Pins get a number at birth. The hub assigns a stable per-project ordinal `n` (additive on the Pin schema, both storage backends) inside the create transaction — an issue number, never renumbered by resolution or reordering. The toolbar's chips, drawer rows, card header, and markdown export all read `pin.n`, falling back to the old visible-index only for pins that predate it.
