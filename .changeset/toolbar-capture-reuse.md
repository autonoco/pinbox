---
"@autono/pinbox-toolbar": patch
---

Screenshots now prompt once per session instead of once per pin: the tab-capture stream is kept alive and reused for every capture (getDisplayMedia must prompt per call by spec, so the fix is to stop re-calling it). Ending the share from the browser's indicator simply re-prompts on the next pin; the toolbar releases the stream on disconnect.
