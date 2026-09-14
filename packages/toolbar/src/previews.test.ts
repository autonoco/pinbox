import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { mountPreviewSwitcher, previewDestination } from "./previews.ts";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test("switching preserves path, query and hash but replaces the origin", () => {
  expect(
    previewDestination("https://pr.example.test", "https://main.example.test/inbox?item=2#note"),
  ).toBe("https://pr.example.test/inbox?item=2#note");
  expect(() => previewDestination("javascript:alert(1)", "https://main.example.test")).toThrow();
});
test("switcher identifies current branch, disables stopped worktrees, and does not duplicate", async () => {
  const win = new Window({ url: "https://main.example.test" });
  const doc = win.document as unknown as Document;
  const host = doc.createElement("div");
  host.attachShadow({ mode: "open" }).innerHTML = '<div class="pb-bar"></div>';
  doc.body.append(host);
  globalThis.fetch = (async () =>
    Response.json({
      ok: true,
      data: [
        {
          id: "a",
          branch: "main",
          commit: "123456789",
          current: true,
          label: "Main",
          backend: "Shared development backend",
          ready: true,
          url: "https://main.example.test",
        },
        {
          id: "b",
          branch: "topic",
          commit: "123",
          current: false,
          label: "PR #2",
          backend: "",
          ready: false,
        },
      ],
    })) as unknown as typeof fetch;
  mountPreviewSwitcher(host, "/__pinbox_previews");
  await new Promise((resolve) => setTimeout(resolve, 0));
  mountPreviewSwitcher(host, "/__pinbox_previews");
  expect(host.shadowRoot?.querySelectorAll(".pb-preview-trigger").length).toBe(1);
  const current = host.shadowRoot?.querySelector('[aria-checked="true"]');
  expect((current as HTMLElement)?.dataset["previewId"]).toBe("a");
  expect(host.shadowRoot?.querySelector<HTMLButtonElement>('[data-preview-id="b"]')?.disabled).toBe(
    true,
  );
  expect(host.shadowRoot?.querySelector(".pb-preview-trigger")?.textContent).toContain("MAIN");
  expect(host.shadowRoot?.textContent).toContain("Shared development backend");
  win.close();
});
