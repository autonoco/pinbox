// Shared canned data + envelope helpers for the workerd suites (both pool projects
// import this — it holds plain data/functions, nothing runtime-specific).

export const PIN_INPUT = {
  text: "button is cut off",
  kind: "note",
  target: {
    url: "http://localhost:3000/",
    selector: "main > button.cta",
    tag: "button",
    rect: { x: 120, y: 480, width: 200, height: 48 },
    fixed: false,
  },
  env: {
    viewport: { w: 1440, h: 900, dpr: 2 },
    browser: "Chrome 130",
    os: "macOS",
    colorScheme: "light",
  },
  author: { userId: "bobak" },
} as const;

export function pinInput(text: string = PIN_INPUT.text) {
  return { ...structuredClone(PIN_INPUT), text };
}

// The frozen machine-output envelope, as the tests see it.
export type Envelope = {
  ok: boolean;
  data?: Record<string, unknown> & { id?: string };
  error?: { code: string; message: string; hint?: string };
};

// [path, init] builder for JSON POSTs carrying `headers` (typically the bearer).
export function makePost(
  headers: Record<string, string>,
): (path: string, body: unknown) => [string, RequestInit] {
  return (path, body) => [
    path,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  ];
}
