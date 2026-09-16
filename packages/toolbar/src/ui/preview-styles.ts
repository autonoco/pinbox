// Match the existing Pinbox command bar and drawer tokens in both themes.
export const PREVIEW_STYLES = `
.pb-preview-wrap { display:flex; align-items:center; border-left:1px solid var(--pb-line); margin-left:4px; padding-left:4px; }
.pb-preview-trigger { max-width:160px; gap:7px; }
.pb-preview-trigger .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:110px; }
.pb-preview-trigger svg { flex-shrink:0; }
.pb-preview-menu { position:fixed; margin:0; padding:0; width:304px; max-width:calc(100vw - 24px); max-height:70vh; overflow:auto; background:var(--pb-surface); color:var(--pb-fg1); border:1px solid var(--pb-line-2); border-radius:4px; box-shadow:var(--pb-shadow); font-family:var(--pb-font-body); }
.pb-preview-menu::backdrop { background:transparent; }
.pb-preview-head { display:flex; align-items:center; justify-content:space-between; padding:10px 12px 8px 16px; border-bottom:1px solid var(--pb-line); }
.pb-preview-head span { font:10px var(--pb-font-mono); letter-spacing:.18em; color:var(--pb-fg3); }
.pb-preview-list { padding:5px; }
.pb-preview-option { display:flex; align-items:center; gap:10px; width:100%; text-align:left; padding:11px 10px; border-radius:2px; color:var(--pb-fg2); }
.pb-preview-option:hover, .pb-preview-option:focus-visible { background:var(--pb-hover); outline:1px solid var(--pb-line-2); }
.pb-preview-option[aria-checked="true"] { background:var(--pb-amber-soft); color:var(--pb-fg1); }
.pb-preview-option:disabled { opacity:.45; cursor:not-allowed; }
.pb-preview-option .check { width:14px; flex-shrink:0; color:var(--pb-amber); }
.pb-preview-option .copy { display:flex; flex-direction:column; gap:4px; min-width:0; }
.pb-preview-option .title { font-size:12px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pb-preview-option .branch { font:10px var(--pb-font-mono); color:var(--pb-fg3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pb-preview-foot { border-top:1px solid var(--pb-line); padding:11px 16px; display:flex; flex-direction:column; gap:8px; }
.pb-preview-status { font-size:11px; line-height:1.5; color:var(--pb-fg3); }
.pb-preview-foot a { font:10px var(--pb-font-mono); letter-spacing:.08em; color:var(--pb-amber); text-decoration:none; }
`;
