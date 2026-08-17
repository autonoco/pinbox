---
"@autono/pinbox-toolbar": minor
---

Dogfood batch: pins stop haunting the wrong views, and the overlay learned some manners. Markers are now anchor-gated — every render re-resolves the captured selector (snapping to the live rect when it has layout) and compares the captured URL's path+search to the live location, so an SPA tab switch takes its pins with it; a MutationObserver + popstate watcher re-renders once per frame when the page changes under us. New: hide/show pins (fan item + `H`) that leaves the drawer intact and auto-unhides when you place; per-pin copy on the thread card (the bar's `C` still copies all open pins); and the theme icon is now a crescent everyone actually reads as "theme".
