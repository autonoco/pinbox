// @autono/pinbox-toolbar — shadow stylesheet
// The prototype's page-level <style> (docs/design/toolbar/v2-command-bar.html
// lines 20–232) translated into Shadow-DOM scope: [data-pb=…] theme blocks become
// :host([data-pb=…]), body.placing becomes :host([data-placing]). Tokens are
// --pb-* custom properties; a host design system overrides them from outside on
// the pinbox-toolbar element (outer-document host rules beat :host rules), so no
// brand is ever baked in. System font stacks only.

/** Dark token block — also the :host default so the bare element renders sanely. */
const DARK_TOKENS = `
  --pb-canvas:#0f0f0f; --pb-surface:#171717; --pb-elev:#1f1c1a; --pb-sunken:#0b0b0b;
  --pb-line:rgba(245,240,230,0.08); --pb-line-2:rgba(245,240,230,0.16);
  --pb-hover:rgba(245,240,230,0.06);
  --pb-fg1:#f5f0e6; --pb-fg2:#b8b0a5; --pb-fg3:#8a827a; --pb-fg4:#5a534d;
  --pb-bar:rgba(15,15,15,0.82);
  --pb-shadow:0 24px 64px rgba(0,0,0,0.6);
  --pb-scrim:rgba(7,7,7,0.62);
  --pb-amber:#d4a04a; --pb-amber-ink:#0f0f0f; --pb-amber-soft:rgba(212,160,74,0.14);
  --pb-ok:#7fb496; --pb-danger:#c46a5a; --pb-info:#8ea6b8;
  --pb-invert-bg:#f5f0e6; --pb-invert-fg:#0f0f0f;
`;

const LIGHT_TOKENS = `
  --pb-canvas:#fbf8f2; --pb-surface:#ffffff; --pb-elev:#ffffff; --pb-sunken:#f2ede3;
  --pb-line:rgba(23,23,23,0.11); --pb-line-2:rgba(23,23,23,0.22);
  --pb-hover:rgba(23,23,23,0.05);
  --pb-fg1:#141414; --pb-fg2:#5a534d; --pb-fg3:#8a827a; --pb-fg4:#b8b0a5;
  --pb-bar:rgba(251,248,242,0.84);
  --pb-shadow:0 24px 64px rgba(58,54,51,0.16);
  --pb-scrim:rgba(58,54,51,0.36);
  --pb-amber:#b07d28; --pb-amber-ink:#fbf8f2; --pb-amber-soft:rgba(176,125,40,0.12);
  --pb-ok:#4e8368; --pb-danger:#a8503f; --pb-info:#5c7c94;
  --pb-invert-bg:#141414; --pb-invert-fg:#fbf8f2;
`;

/** Full shadow-root stylesheet for the toolbar element. */
export const TOOLBAR_CSS = `
:host { ${DARK_TOKENS}
  --pb-font-body: ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
  --pb-font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --pb-ease: cubic-bezier(0.22, 1, 0.36, 1);
  position: absolute; top: 0; left: 0; width: 100%; height: 0; z-index: 2147483000;
  color: var(--pb-fg1); font-family: var(--pb-font-body); -webkit-font-smoothing: antialiased;
}
:host([data-pb="dark"]) { ${DARK_TOKENS} }
:host([data-pb="light"]) { ${LIGHT_TOKENS} }
*, *::before, *::after { box-sizing: border-box; margin: 0; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }

@keyframes pb-chip { 0% { opacity:0; transform:translateY(-14px) } 60% { opacity:1 } 100% { opacity:1; transform:translateY(0) } }
@keyframes pb-needle { from { transform:scaleY(0) } to { transform:scaleY(1) } }
@keyframes pb-ring { from { opacity:.6; transform:translate(-50%,-50%) scale(.25) } to { opacity:0; transform:translate(-50%,-50%) scale(3.2) } }
@keyframes pb-in { from { opacity:0; transform:translateY(7px) } to { opacity:1; transform:none } }
@keyframes pb-fade { from { opacity:0 } to { opacity:1 } }
@keyframes pb-drawer { from { transform:translateX(100%) } to { transform:none } }
@keyframes pb-drawer-out { to { transform:translateX(100%) } }
@keyframes pb-caret { 50% { opacity:0 } }
@keyframes pb-pulse { 0%,100% { opacity:.3 } 50% { opacity:1 } }
@keyframes pb-resolve { to { opacity:0; transform:translateY(-10px) } }

/* overlay layer at the document origin */
.pb-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 0; }

.pb-outline { position: absolute; z-index: 30; pointer-events: none; border: 1px solid var(--pb-amber); border-radius: 2px; background: var(--pb-amber-soft); opacity: 0;
  transition: left 220ms var(--pb-ease), top 220ms var(--pb-ease), width 220ms var(--pb-ease), height 220ms var(--pb-ease), opacity 150ms linear; }
.pb-outline.on { opacity: 1; }
.pb-outline .lab { position: absolute; top: -20px; left: -1px; padding: 2px 7px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .16em; white-space: nowrap; border-radius: 2px; }

.pb-reticle { position: fixed; inset: 0; pointer-events: none; z-index: 50; display: none; }
:host([data-placing]) .pb-reticle { display: block; animation: pb-fade 160ms ease-out both; }
.pb-reticle .h { position: absolute; left: 0; right: 0; height: 1px; background: color-mix(in srgb, var(--pb-amber) 26%, transparent); }
.pb-reticle .v { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--pb-amber) 26%, transparent); }
.pb-reticle .box { position: absolute; width: 15px; height: 15px; margin: -8px 0 0 -8px; border: 1px solid var(--pb-amber); border-radius: 2px; }
.pb-reticle .ro { position: absolute; margin: 14px 0 0 14px; padding: 3px 6px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .12em; border-radius: 2px; white-space: nowrap; }

/* Drag-to-aim, for touch. The layer never takes pointer events — only the grip and the bar do —
   so what is under the crosshair can still be probed, and the page underneath is still visible. */
/* Above the command bar (90), below the shortcuts modal (120). The confirm bar sits at the very
   bottom of the screen, where the command bar already is — under it, CONFIRM was unclickable. */
.pb-aim { position: fixed; inset: 0; z-index: 100; display: none; pointer-events: none; }
.pb-aim.on { display: block; animation: pb-fade 160ms ease-out both; }
.pb-aim .h { position: absolute; left: 0; right: 0; height: 1px; background: color-mix(in srgb, var(--pb-amber) 30%, transparent); }
.pb-aim .v { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--pb-amber) 30%, transparent); }
/* 72px: a finger-sized target, per the design. Smaller and you cannot hold it accurately;
   touch-action:none is what stops the page scrolling instead of the reticle moving. */
.pb-aim .grip { position: absolute; width: 72px; height: 72px; margin: -36px 0 0 -36px; border-radius: 999px; border: 1px solid var(--pb-amber); background: var(--pb-amber-soft); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; pointer-events: auto; touch-action: none; cursor: grab; }
.pb-aim .grip:active { cursor: grabbing; }
.pb-aim .grip i { width: 10px; height: 10px; border-radius: 999px; background: var(--pb-amber); box-shadow: 0 0 0 3px var(--pb-canvas); }
.pb-aim .bar { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px; padding: 7px; background: var(--pb-bar); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); pointer-events: auto; }
.pb-aim .bar .lab { flex: 1; min-width: 0; padding-left: 8px; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .14em; color: var(--pb-fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 48px tall: the minimum a thumb hits reliably. */
.pb-aim .bar button { height: 48px; border-radius: 2px; font-family: var(--pb-font-mono); font-size: 11px; letter-spacing: .16em; cursor: pointer; }
.pb-aim .bar .cancel { flex: none; padding: 0 18px; border: 1px solid var(--pb-line-2); background: transparent; color: var(--pb-fg2); }
.pb-aim .bar .ok { flex: none; padding: 0 20px; border: none; background: var(--pb-amber); color: var(--pb-amber-ink); }

.pb-pin { position: absolute; }
.pb-pin.resolving { animation: pb-resolve 380ms var(--pb-ease) forwards; }
.pb-pin .ring { position: absolute; left: 0; top: 0; width: 26px; height: 26px; border: 1px solid var(--pb-amber); border-radius: 999px; animation: pb-ring 900ms var(--pb-ease) forwards; pointer-events: none; }
.pb-pin .dot { position: absolute; left: -3px; top: -3px; width: 7px; height: 7px; border-radius: 999px; background: var(--pb-amber); box-shadow: 0 0 0 2px var(--pb-canvas); }
.pb-pin .needle { position: absolute; left: 0; bottom: 0; width: 1px; height: 30px; background: linear-gradient(to top, var(--pb-amber), color-mix(in srgb, var(--pb-amber) 35%, transparent)); transform-origin: bottom; animation: pb-needle 300ms var(--pb-ease) both; }
.pb-chipBtn { position: absolute; left: -1px; bottom: 30px; display: flex; align-items: center; gap: 7px; height: 26px; padding: 0 9px; border-radius: 2px; border: 1px solid var(--pb-line-2); background: var(--pb-elev); color: var(--pb-fg1); font-family: var(--pb-font-mono); font-size: 11px; font-weight: 500; letter-spacing: .08em; white-space: nowrap; box-shadow: var(--pb-shadow); animation: pb-chip 420ms var(--pb-ease) both; transition: border-color 160ms linear, background 160ms linear, color 160ms linear; }
.pb-chipBtn:hover { border-color: var(--pb-amber); }
.pb-pin.hot .pb-chipBtn { background: var(--pb-amber); color: var(--pb-amber-ink); border-color: var(--pb-amber); box-shadow: 0 0 0 4px var(--pb-amber-soft); }
.pb-chipBtn .busy { width: 5px; height: 5px; border-radius: 999px; background: currentColor; animation: pb-pulse 1s ease-in-out infinite; }
.pb-chipBtn .lk { display: flex; align-items: center; gap: 5px; padding-left: 6px; margin-left: 1px; border-left: 1px solid var(--pb-line-2); font-size: 9.5px; letter-spacing: .02em; opacity: .85; }
.pb-pin.hot .pb-chipBtn .lk { border-left-color: color-mix(in srgb, var(--pb-amber-ink) 28%, transparent); }
.pb-pin.queued .pb-chipBtn { border-style: dashed; }
.pb-chipBtn .qd { padding-left: 6px; margin-left: 1px; border-left: 1px solid var(--pb-line-2); font-size: 9px; letter-spacing: .12em; color: var(--pb-amber); }
.pb-pin.hot .pb-chipBtn .qd { color: var(--pb-amber-ink); border-left-color: color-mix(in srgb, var(--pb-amber-ink) 28%, transparent); }

/* thread card (ui/card.ts) — prototype lines 121–190 */
.pb-card { position: absolute; z-index: 80; width: 344px; }
.pb-card .in { animation: pb-in 260ms var(--pb-ease) both; background: var(--pb-elev); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); overflow: hidden; }
.pb-hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--pb-line); background: var(--pb-surface); }
.pb-hd .meta { display: flex; align-items: center; gap: 9px; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .18em; color: var(--pb-fg3); }
.pb-hd .meta .num { color: var(--pb-amber); }
.pb-hd .meta .st { color: var(--pb-fg4); }
.pb-ico { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 2px; color: var(--pb-fg3); }
.pb-ico:hover { background: var(--pb-hover); color: var(--pb-fg1); }
.pb-ico.ok:hover { color: var(--pb-ok); }
.pb-linkbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--pb-line); background: color-mix(in srgb, var(--pb-info) 7%, var(--pb-surface)); animation: pb-in 300ms var(--pb-ease) both; }
.pb-linkbar .ch { white-space: nowrap; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .06em; }
.pb-linkbar .mt { white-space: nowrap; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg4); }
.pb-linkbar .sp { flex: 1; }
.pb-open { display: flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border: 1px solid var(--pb-line-2); border-radius: 2px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg2); text-decoration: none; }
.pb-open:hover { border-color: var(--pb-info); color: var(--pb-fg1); }
.pb-thread { max-height: min(392px, calc(100vh - 320px)); overflow: auto; }
.pb-msg-w { animation: pb-in 260ms var(--pb-ease) both; }
.pb-msg { padding: 13px 14px; display: flex; gap: 10px; }
.pb-msg.you { border-bottom: 1px solid var(--pb-line); }
.pb-typing { padding: 13px 14px; display: flex; gap: 10px; align-items: center; }
.pb-typing .dots { display: flex; gap: 4px; }
.pb-typing .dots i { width: 4px; height: 4px; border-radius: 999px; background: var(--pb-amber); animation: pb-pulse 1.1s var(--pb-ease) infinite; }
.pb-typing .dots i:nth-child(2) { animation-delay: .18s; }
.pb-typing .dots i:nth-child(3) { animation-delay: .36s; }
.pb-typing .lbl { font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg3); }
.pb-msg .steps { display: flex; flex-direction: column; gap: 7px; }
.pb-av { flex: none; width: 22px; height: 22px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .04em; background: var(--pb-invert-bg); color: var(--pb-invert-fg); border: 1px solid var(--pb-invert-bg); }
.pb-av.via { background: transparent; color: var(--pb-info); border-color: var(--pb-info); }
.pb-av.agent { background: var(--pb-amber-soft); color: var(--pb-amber); border-color: var(--pb-amber); }
.pb-msg .col { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pb-msg .line { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.pb-msg .who { font-size: 12px; }
.pb-msg .tm { font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg4); }
.pb-msg .via-tag { display: flex; align-items: center; gap: 4px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .06em; color: var(--pb-fg3); }
.pb-msg .txt { font-size: 13px; line-height: 1.55; letter-spacing: -.005em; color: var(--pb-fg2); text-wrap: pretty; overflow-wrap: anywhere; }
.pb-msg .atts { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 2px; }
.pb-att img { display: block; max-width: 132px; max-height: 88px; border: 1px solid var(--pb-line-2); border-radius: 2px; }
.pb-att-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border: 1px solid var(--pb-line-2); border-radius: 2px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .06em; color: var(--pb-fg3); }
.pb-step { display: flex; align-items: center; gap: 8px; font-family: var(--pb-font-mono); font-size: 10.5px; letter-spacing: .02em; animation: pb-fade 220ms ease-out both; }
.pb-step .g { width: 10px; display: flex; justify-content: center; }
.pb-caret { display: inline-block; width: 6px; height: 14px; margin-left: 2px; transform: translateY(2px); background: var(--pb-amber); animation: pb-caret 900ms steps(1) infinite; }
.pb-change { margin: 0 14px 14px 46px; border: 1px solid var(--pb-line); border-radius: 2px; overflow: hidden; }
.pb-change .fh { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; background: var(--pb-surface); border-bottom: 1px solid var(--pb-line); font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .14em; color: var(--pb-fg3); }
.pb-change .code { background: var(--pb-sunken); padding: 8px 0; font-family: var(--pb-font-mono); font-size: 10.5px; line-height: 1.75; }
.pb-change .mi { padding: 0 10px; color: var(--pb-danger); background: color-mix(in srgb, var(--pb-danger) 9%, transparent); white-space: pre; overflow: auto; }
.pb-change .pl { padding: 0 10px; color: var(--pb-ok); background: color-mix(in srgb, var(--pb-ok) 9%, transparent); white-space: pre; overflow: auto; }
.pb-change .ft { display: flex; align-items: center; gap: 8px; padding: 9px 10px; background: var(--pb-surface); border-top: 1px solid var(--pb-line); }
.pb-change .applied { font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .16em; color: var(--pb-ok); display: flex; align-items: center; gap: 8px; }
.pb-change .applied .hh { color: var(--pb-fg4); }
.pb-verify { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--pb-surface); border-top: 1px solid var(--pb-line); }
.pb-bt-solid { height: 26px; padding: 0 13px; border-radius: 2px; background: var(--pb-invert-bg); color: var(--pb-invert-fg); font-size: 11.5px; }
.pb-bt-solid:hover { opacity: .9; }
.pb-bt-ok { height: 26px; padding: 0 13px; border-radius: 2px; background: var(--pb-ok); color: var(--pb-canvas); font-size: 11.5px; }
.pb-bt-ok:hover { opacity: .9; }
.pb-bt-ghost { height: 26px; padding: 0 13px; border: 1px solid var(--pb-line-2); border-radius: 2px; color: var(--pb-fg2); font-size: 11.5px; }
.pb-bt-ghost:hover { color: var(--pb-fg1); border-color: var(--pb-fg3); }
.pb-composer { border-top: 1px solid var(--pb-line); padding: 11px 12px; background: var(--pb-surface); }
.pb-composer textarea { width: 100%; resize: none; background: var(--pb-sunken); border: 1px solid var(--pb-line); border-radius: 2px; padding: 9px 10px; color: var(--pb-fg1); font-family: var(--pb-font-body); font-size: 13px; line-height: 1.5; letter-spacing: -.005em; outline: none; }
.pb-composer textarea:focus { border-color: var(--pb-amber); box-shadow: 0 0 0 3px var(--pb-amber-soft); }
.pb-composer .row { display: flex; align-items: center; justify-content: space-between; padding-top: 9px; }
.pb-kbd { font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .14em; color: var(--pb-fg4); }

/* command bar */
.pb-bar { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 90; display: flex; align-items: center; height: 46px; padding: 0 6px; gap: 3px; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); }
.pb-bar .armed-ring { position: absolute; inset: -1px; border: 1px solid var(--pb-amber); border-radius: 4px; box-shadow: 0 0 32px var(--pb-amber-soft); pointer-events: none; animation: pb-fade 200ms ease-out both; display: none; }
:host([data-placing]) .pb-bar .armed-ring { display: block; }
.pb-bar .ident { display: flex; align-items: center; gap: 9px; padding: 0 12px 0 10px; min-width: 150px; }
.pb-bar .ident .bl { font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .24em; white-space: nowrap; }
.pb-bar .div { width: 1px; height: 22px; background: var(--pb-line); }
.pb-tb { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 11px; border-radius: 2px; color: var(--pb-fg2); transition: background 140ms linear; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .16em; }
.pb-tb:hover { background: var(--pb-hover); }
.pb-tb.hot { background: var(--pb-amber); color: var(--pb-amber-ink); }
.pb-tb.lit { background: var(--pb-hover); color: var(--pb-fg1); }
.pb-tb.sq { width: 32px; padding: 0; justify-content: center; }

/* inbox drawer (ui/drawer.ts) — prototype lines 206–224 */
.pb-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 336px; z-index: 85; background: var(--pb-surface); border-left: 1px solid var(--pb-line); box-shadow: var(--pb-shadow); display: flex; flex-direction: column; animation: pb-drawer 380ms var(--pb-ease) both; }
.pb-drawer.closing { animation: pb-drawer-out 220ms cubic-bezier(0.3, 0, 0.8, 0.15) both; }
.pb-drawer .dh { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 12px; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .24em; }
.pb-tabs { display: flex; gap: 18px; padding: 0 16px; border-bottom: 1px solid var(--pb-line); }
.pb-tab { padding: 0 0 10px; white-space: nowrap; font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .18em; color: var(--pb-fg3); border-bottom: 1px solid transparent; }
.pb-tab.on { color: var(--pb-fg1); border-bottom-color: var(--pb-amber); }
.pb-items { flex: 1; overflow: auto; }
.pb-item { width: 100%; text-align: left; display: flex; gap: 11px; padding: 14px 16px; border-bottom: 1px solid var(--pb-line); }
.pb-item:hover { background: var(--pb-hover); }
.pb-item .nn { flex: none; display: flex; align-items: center; justify-content: center; min-width: 24px; height: 20px; border-radius: 2px; border: 1px solid var(--pb-line-2); color: var(--pb-fg2); font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .06em; }
.pb-item.on .nn { background: var(--pb-amber); color: var(--pb-amber-ink); border-color: var(--pb-amber); }
.pb-item .cc { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.pb-item .tt { font-size: 12.5px; line-height: 1.45; letter-spacing: -.005em; color: var(--pb-fg1); text-wrap: pretty; }
.pb-item .mm { display: flex; align-items: center; gap: 7px; font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg4); }
.pb-item .mm .sdot { width: 5px; height: 5px; border-radius: 999px; }
.pb-empty { padding: 26px 16px; font-size: 12.5px; color: var(--pb-fg3); }

/* minimize: floating puck + morph layer (ui/puck.ts, minimize.ts) — v3 design.
   The morph surface is styled identically to the bar so endpoint handoffs are
   pixel-invisible. Ghosting keeps layout (getBoundingClientRect still measures
   morph targets) while dropping the element from paint and the tab order. */
.pb-ghost { opacity: 0 !important; pointer-events: none !important; visibility: hidden; transition: opacity 90ms linear, visibility 0s 90ms; }
.pb-bar { transition: opacity 90ms linear; }
.pb-morph-wrap { position: fixed; inset: 0; z-index: 89; pointer-events: none; opacity: 0; transition: opacity 90ms linear; }
.pb-morph-wrap.on { opacity: 1; }
.pb-morph { position: absolute; left: 0; top: 0; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); box-shadow: var(--pb-shadow); will-change: transform, width, height; }
.pb-carrier { position: absolute; left: 0; top: 0; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; color: var(--pb-amber); opacity: 0; transition: opacity 140ms linear; will-change: transform; }
.pb-carrier.show { opacity: 1; }
/* Above the bar (90) and drawer (85), below the aim layer (100) and modal (120). */
.pb-puck { position: fixed; left: 0; top: 0; width: 48px; height: 48px; z-index: 95; border-radius: 999px; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); box-shadow: var(--pb-shadow); display: flex; align-items: center; justify-content: center; color: var(--pb-amber); cursor: grab; touch-action: none; transition: opacity 90ms linear; }
.pb-puck:active { cursor: grabbing; }
.pb-puck .in { display: flex; transition: transform 160ms var(--pb-ease); }
.pb-puck:hover .in { transform: scale(1.12); }
.pb-puck .badge, .pb-carrier .badge, .pb-fan-item .badge { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9px; font-weight: 500; display: flex; align-items: center; justify-content: center; }
/* The bar says "· OFFLINE" in words; the puck's amber dot is the same signal. */
.pb-puck .cdot { position: absolute; bottom: -1px; right: -1px; width: 9px; height: 9px; border-radius: 999px; background: var(--pb-amber); border: 2px solid var(--pb-canvas); display: none; }
.pb-puck.degraded .cdot { display: block; }
/* Placing armed from the fan: the bar's armed-ring is hidden with the bar. */
.pb-puck.armed { border-color: var(--pb-amber); box-shadow: 0 0 0 4px var(--pb-amber-soft), var(--pb-shadow); }

/* puck fan menu (ui/puck.ts, minimize.ts) — tap the puck and a vertical
   quick-menu fans out of it; EXPAND is how the bar comes back. Items stagger
   from the puck; hovering slides a label + key chip toward screen center. */
.pb-fan { position: fixed; z-index: 96; display: flex; flex-direction: column; gap: 6px; align-items: center; }
.pb-fan-item { position: relative; width: 40px; height: 40px; border-radius: 999px; background: var(--pb-bar); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--pb-line-2); box-shadow: var(--pb-shadow); color: var(--pb-fg2); display: flex; align-items: center; justify-content: center; opacity: 0; transform: var(--fan-from) scale(0.5); transition: transform 300ms var(--pb-ease), opacity 180ms linear, color 140ms linear, border-color 140ms linear; transition-delay: calc(var(--i) * 35ms); }
.pb-fan.up { --fan-from: translateY(16px); }
.pb-fan.down { --fan-from: translateY(-16px); }
.pb-fan.on .pb-fan-item { opacity: 1; transform: none; }
.pb-fan-item:hover { color: var(--pb-amber); border-color: var(--pb-amber); }
.pb-fan-item.lit { color: var(--pb-amber); border-color: var(--pb-amber); }
.pb-multi-mark { position: absolute; border: 1.5px dashed var(--pb-amber); border-radius: 4px; pointer-events: none; z-index: 15; }
.pb-multi-mark span { position: absolute; top: -9px; left: -9px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--pb-amber); color: var(--pb-amber-ink); font-family: var(--pb-font-mono); font-size: 9px; font-weight: 500; display: flex; align-items: center; justify-content: center; }
.pb-loci { padding: 6px 14px 0; font-family: var(--pb-font-mono); font-size: 9.5px; letter-spacing: .04em; color: var(--pb-fg3); overflow-wrap: anywhere; }
.pb-fan-item .badge { pointer-events: none; }
.pb-fan-item .fl { position: absolute; top: 50%; display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--pb-elev); border: 1px solid var(--pb-line-2); border-radius: 2px; box-shadow: var(--pb-shadow); font-family: var(--pb-font-mono); font-size: 9px; letter-spacing: .14em; color: var(--pb-fg1); white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity 140ms linear, transform 200ms var(--pb-ease); }
.pb-fan.labels-right .fl { left: calc(100% + 10px); transform: translateY(-50%) translateX(-6px); }
.pb-fan.labels-left .fl { right: calc(100% + 10px); transform: translateY(-50%) translateX(6px); }
.pb-fan-item:hover .fl { opacity: 1; transform: translateY(-50%) translateX(0); }
.pb-fan-item .fl i { font-style: normal; padding: 1px 5px; border: 1px solid var(--pb-line-2); border-radius: 2px; background: var(--pb-sunken); color: var(--pb-fg3); }

/* shortcuts modal (ui/shortcuts.ts) — prototype lines 226–232 */
.pb-modal { position: fixed; inset: 0; z-index: 120; display: flex; align-items: center; justify-content: center; background: var(--pb-scrim); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); animation: pb-fade 200ms ease-out both; }
.pb-modal .mx { width: 430px; background: var(--pb-elev); border: 1px solid var(--pb-line-2); border-radius: 4px; box-shadow: var(--pb-shadow); animation: pb-in 280ms var(--pb-ease) both; }
.pb-modal .mh { padding: 18px 20px 14px; border-bottom: 1px solid var(--pb-line); font-family: var(--pb-font-mono); font-size: 10px; letter-spacing: .24em; }
.pb-modal .mr { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--pb-line); }
.pb-modal .mw { font-size: 13px; letter-spacing: -.005em; color: var(--pb-fg2); }
.pb-modal .mk { display: flex; align-items: center; justify-content: center; min-width: 26px; height: 22px; padding: 0 7px; border: 1px solid var(--pb-line-2); border-radius: 2px; background: var(--pb-sunken); font-family: var(--pb-font-mono); font-size: 10.5px; }

[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; animation-iteration-count: 1 !important; } .pb-chipBtn .busy, .pb-caret { animation: none; } }
`;

/**
 * The one rule that must live in the host document, not the shadow root: the
 * armed-state cursor flip (prototype line 100: body.placing cursor none). The
 * element injects this <style> on connect and toggles PAGE_PLACING_CLASS on body.
 */
export const PAGE_PLACING_CLASS = "pinbox-placing";
export const PAGE_CSS = `body.${PAGE_PLACING_CLASS}, body.${PAGE_PLACING_CLASS} * { cursor: none !important; }`;
