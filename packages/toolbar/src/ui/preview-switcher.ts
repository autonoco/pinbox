import type { PreviewChoice } from "../previews.ts";
import { icon } from "./actions.ts";
import { PREVIEW_STYLES } from "./preview-styles.ts";

const CHEVRON = icon('<path d="m4 6 4 4 4-4"/>', 14);
const REFRESH = icon(
  '<path d="M2 8a6 6 0 0 1 10.5-4L14 6M14 2v4h-4M14 8a6 6 0 0 1-10.5 4L2 10M2 14v-4h4"/>',
  14,
);

const BRANCH =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><circle cx="12" cy="4" r="1.5"/><path d="M4 4.5v7M12 5.5v1a3 3 0 0 1-3 3H7a3 3 0 0 0-3 3"/></svg>';

export function createPreviewView(doc: Document, root: ShadowRoot, bar: Element) {
  const style = doc.createElement("style");
  style.textContent = PREVIEW_STYLES;
  root.append(style);
  const wrap = doc.createElement("div");
  wrap.dataset["previewSwitcher"] = "";
  wrap.className = "pb-preview-wrap";
  wrap.innerHTML = `<button type="button" class="pb-tb pb-preview-trigger" aria-label="Switch preview" aria-haspopup="menu" aria-controls="pb-preview-menu" aria-expanded="false">${BRANCH}<span class="name">PREVIEW</span>${CHEVRON}</button>
    <div id="pb-preview-menu" class="pb-preview-menu" popover="auto" aria-label="Local previews">
      <div class="pb-preview-head"><span>LOCAL PREVIEWS</span><button type="button" class="pb-tb sq" aria-label="Refresh previews">${REFRESH}</button></div>
      <div class="pb-preview-list" role="menu" aria-label="Preview branch or worktree"></div>
      <div class="pb-preview-foot"><span class="pb-preview-status" role="status">Loading previews…</span><a target="_blank" rel="noopener noreferrer" hidden>OPEN PR ↗</a></div>
    </div>`;
  bar.append(wrap);
  const trigger = wrap.querySelector<HTMLButtonElement>(".pb-preview-trigger") as HTMLButtonElement;
  const panel = wrap.querySelector<HTMLElement>(".pb-preview-menu") as HTMLElement;
  const list = wrap.querySelector<HTMLElement>(".pb-preview-list") as HTMLElement;
  const reload = wrap.querySelector<HTMLButtonElement>(
    '[aria-label="Refresh previews"]',
  ) as HTMLButtonElement;
  const status = wrap.querySelector<HTMLElement>('[role="status"]') as HTMLElement;
  const pr = wrap.querySelector<HTMLAnchorElement>("a") as HTMLAnchorElement;
  wirePopover(trigger, panel, list, doc);
  return {
    trigger,
    list,
    status,
    reload,
    render(choices: PreviewChoice[]) {
      renderOptions(doc, list, choices);
      const current = choices.find((p) => p.current);
      (trigger.querySelector(".name") as HTMLElement).textContent = compactLabel(current);
      trigger.setAttribute("aria-label", `Switch preview: ${current?.label ?? "local previews"}`);
      trigger.title = current
        ? `${current.branch} · ${current.commit.slice(0, 8)}`
        : "Choose a preview";
      status.textContent = current?.backend || "Local frontend preview";
      pr.hidden = !current?.pr;
      if (current?.pr) pr.href = current.pr;
    },
  };
}

function compactLabel(current?: PreviewChoice): string {
  if (!current) return "PREVIEW";
  const number = current.label.match(/^PR #\d+/)?.[0];
  return number ?? (current.branch === "main" ? "MAIN" : current.branch.replace(/^[^/]+\//, ""));
}

function renderOptions(doc: Document, list: HTMLElement, choices: PreviewChoice[]) {
  list.replaceChildren();
  for (const item of choices) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "pb-preview-option";
    button.dataset["previewId"] = item.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(item.current));
    button.disabled = !item.ready;
    button.innerHTML =
      '<span class="check" aria-hidden="true"></span><span class="copy"><span class="title"></span><span class="branch"></span></span>';
    (button.querySelector(".check") as HTMLElement).textContent = item.current ? "✓" : "";
    (button.querySelector(".title") as HTMLElement).textContent = item.label;
    (button.querySelector(".branch") as HTMLElement).textContent =
      `${item.branch}${item.ready ? "" : " · unavailable"}`;
    list.append(button);
  }
}

function wirePopover(
  trigger: HTMLButtonElement,
  panel: HTMLElement,
  list: HTMLElement,
  doc: Document,
) {
  trigger.addEventListener("click", () => {
    panel.togglePopover();
    const rect = trigger.getBoundingClientRect();
    const width = doc.documentElement.clientWidth;
    panel.style.left = `${Math.max(12, Math.min(rect.right - 304, width - 316))}px`;
    panel.style.top = `${rect.top > panel.offsetHeight + 20 ? rect.top - panel.offsetHeight - 10 : rect.bottom + 10}px`;
    (
      list.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)') ??
      list.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus();
  });
  panel.addEventListener("toggle", () =>
    trigger.setAttribute("aria-expanded", String(panel.matches(":popover-open"))),
  );
  panel.addEventListener("keydown", (e) => {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = buttons.indexOf(
      (panel.getRootNode() as ShadowRoot).activeElement as HTMLButtonElement,
    );
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
    if (e.key === "Escape") {
      panel.hidePopover();
      trigger.focus();
    }
  });
}
