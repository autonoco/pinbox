import { createPreviewView } from "./ui/preview-switcher.ts";

/** Dev-plugin UI. Navigation changes this browser only; each destination owns its hub. */
export type PreviewChoice = {
  id: string;
  branch: string;
  commit: string;
  current: boolean;
  label: string;
  backend: string;
  url?: string;
  pr?: string;
  ready: boolean;
};

export function previewDestination(origin: string, current: string): string {
  const target = new URL(origin);
  const source = new URL(current);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error("Invalid preview origin");
  target.pathname = source.pathname;
  target.search = source.search;
  target.hash = source.hash;
  return target.href;
}

export function mountPreviewSwitcher(host: HTMLElement, endpoint: string): void {
  const root = host.shadowRoot;
  const bar = root?.querySelector(".pb-bar");
  if (!root || !bar || root.querySelector("[data-preview-switcher]")) return;
  const doc = host.ownerDocument;
  const { trigger, list, status, reload, render } = createPreviewView(doc, root, bar);
  let choices: PreviewChoice[] = [];
  let busy = false;
  const load = async (): Promise<PreviewChoice[]> => {
    const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
    const envelope = await response.json();
    if (!response.ok || !envelope.ok || !Array.isArray(envelope.data))
      throw new Error("Preview discovery unavailable");
    return envelope.data;
  };
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      choices = await load();
      render(choices);
      trigger.disabled = false;
    } catch {
      status.textContent = "Preview discovery unavailable";
      trigger.disabled = false;
    } finally {
      busy = false;
    }
  }
  reload.addEventListener("click", () => {
    void refresh();
  });
  list.addEventListener("click", async (event) => {
    const target = (event.target as Element).closest<HTMLButtonElement>("[data-preview-id]");
    const id = target?.dataset["previewId"];
    if (!id || target?.disabled) return;
    trigger.disabled = true;
    status.textContent = "Checking preview…";
    try {
      const destination = (await load()).find((p) => p.id === id);
      if (!destination?.ready || !destination.url) throw new Error("unavailable");
      doc.defaultView?.location.assign(previewDestination(destination.url, doc.location.href));
    } catch {
      status.textContent = "Preview unavailable. Refresh to try again.";
      trigger.disabled = false;
    }
  });
  void refresh();
}
