# examples/script-tag

Plain static HTML using `dist/toolbar.iife.js` — proves the no-framework embed path.

The bundle exposes the API flat on `window`, so the whole install is two tags:

```html
<script src="/path/to/toolbar.iife.js"></script>
<script>
  Pinbox.init({ endpoint: "http://127.0.0.1:4319" });
</script>
```

Not `Pinbox.Pinbox.init` — see `packages/toolbar/README.md` for why the iife entry is
`src/iife.ts` and which test holds that shape in place.
