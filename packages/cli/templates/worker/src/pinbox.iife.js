// Served verbatim at /_pinbox/pinbox.js (Text rule in wrangler.jsonc) — the slot for the
// @autono/pinbox-toolbar IIFE build. The release pipeline embeds the built toolbar bundle
// below the bootstrap; until then the bootstrap wires the page config end to end so the
// injected snippet, the hub mount, and the serving route are all real and testable.
(() => {
  const script = document.currentScript;
  const dataset = script?.dataset ?? {};
  const config = {
    hub: dataset.pinboxHub || "/_pinbox",
    origin: dataset.pinboxOrigin || "",
  };
  window.__PINBOX__ = config;
  if (!window.customElements?.get("pinbox-toolbar")) {
    console.info(`[pinbox] hub mounted at ${config.hub}; toolbar bundle not embedded yet`);
  }
})();
