---
"@autono/pinbox-toolbar": minor
---

Minimize the command bar to a floating puck. A new bar button (or `M`) collapses the bar into a draggable 48px puck — spring-morphed via a bar-styled surface so the handoffs are seamless — showing the open-pin count and a degraded-connection dot. Tap the puck (or `M`) to restore; drag it anywhere, the spot persists per endpoint. Additive API: `PinboxConfig.minimized`, element `minimize()`/`restore()`, and `pinbox:minimize`/`pinbox:restore` events.
