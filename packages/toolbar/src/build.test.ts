// @autono/pinbox-toolbar — distribution shape tests.
//
// Guards the two things a consumer's resolver cares about and TypeScript cannot check:
// that every `exports` subpath in package.json has a real emitted file behind it, and that
// the script-tag IIFE bundle actually assigns the `Pinbox` global. Both are properties of
// tsdown.config.ts, so this file is that config's colocated test.
//
// The build is run on demand when `dist/` is missing so `bun test` is self-sufficient
// (ci:validate builds first, in which case this is a no-op stat).
import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { build as viteBuild } from "vite";

const pkgRoot = new URL("..", import.meta.url).pathname;
const dist = (rel: string): string => `${pkgRoot}dist/${rel}`;

async function ensureBuilt(): Promise<void> {
  if (await Bun.file(dist("toolbar.iife.js")).exists()) return;
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: pkgRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(`toolbar build failed: ${await new Response(proc.stderr).text()}`);
}

beforeAll(async () => {
  await ensureBuilt();
});

describe("dist layout", () => {
  test.each([
    "index.js",
    "index.d.ts",
    "react.js",
    "react.d.ts",
    "vue.js",
    "vue.d.ts",
    "svelte.js",
    "svelte.d.ts",
    "plugins/vite.js",
    "plugins/next.js",
    "toolbar.iife.js",
  ])("emits dist/%s", async (rel) => {
    expect(await Bun.file(dist(rel)).exists()).toBe(true);
  });

  test("wrapper subpaths carry no framework runtime into the vanilla entry", async () => {
    const index = await Bun.file(dist("index.js")).text();
    expect(index).not.toContain('from "react"');
    expect(index).not.toContain('from "vue"');
    expect(index).not.toContain('from "svelte');
  });
});

describe("esm entry side effects", () => {
  // The dev plugins' bootstrap is a BARE `import "@autono/pinbox-toolbar"` (src/plugins/snippet.ts)
  // that binds no name — its only purpose is registering <pinbox-toolbar>. Whether that import
  // survives is decided by package.json `sideEffects` matching the file that actually carries the
  // top-level `defineToolbarElement()` call, which is an emergent property of tsdown's CHUNKING:
  // once the wrapper entries share code with src/index.ts, the registration moves into a
  // hash-named chunk and an allowlist naming only ./dist/index.js stops covering it. Statting or
  // grepping dist/ cannot see that. Only a real tree-shaking bundler can, so this test runs one.
  test("a bare side-effect import survives a tree-shaking bundler", async () => {
    // Inside the package's own node_modules so plain node resolution finds
    // `@autono/pinbox-toolbar` (the workspace link) with no alias — an alias would bypass the
    // exports/sideEffects lookup that is the whole subject of the test.
    const scratch = `${pkgRoot}node_modules/.pinbox-sideeffects-test`;
    await Bun.write(`${scratch}/entry.js`, 'import "@autono/pinbox-toolbar";\n');

    const result = await viteBuild({
      root: scratch,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        lib: { entry: `${scratch}/entry.js`, formats: ["es"], fileName: "bundle" },
      },
    });

    // One bundle per configured format (a watcher, which has no `output`, only when
    // build.watch is set — never here). `write: false` keeps the chunks in memory.
    const bundles = Array.isArray(result) ? result : [result];
    const code = bundles
      .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
      .map((chunk) => (chunk.type === "chunk" ? chunk.code : ""))
      .join("\n");
    expect(code).toContain("customElements.define");
  }, 60_000);
});

describe("iife bundle", () => {
  /** What a script tag leaves on `window` — `Pinbox` is here only so its ABSENCE is checkable. */
  interface ToolbarGlobal {
    init?: (config: { endpoint: string }) => unknown;
    defineToolbarElement?: () => void;
    Pinbox?: unknown;
  }

  // Run the bundle for real against a happy-dom realm rather than only grepping for the
  // assignment. happy-dom does not execute inline <script> nodes, so the browser globals the
  // bundle touches at module scope are passed as parameters and the `var` is returned — the
  // same binding a script tag would leave on `window`. The only input to `new Function` here
  // is our own build artifact, read from dist/ — never anything user- or network-supplied.
  async function evaluateBundle(): Promise<{ window: Window; global: ToolbarGlobal }> {
    const source = await Bun.file(dist("toolbar.iife.js")).text();
    const window = new Window({ url: "http://127.0.0.1:5173/" });
    const evaluate = new Function(
      "window",
      "document",
      "customElements",
      "HTMLElement",
      `${source}\nreturn Pinbox;`,
    ) as (...globals: unknown[]) => ToolbarGlobal;
    // src/element.ts picks its base class off `globalThis.HTMLElement` (its SSR guard), which Bun
    // does not define — without this the class extends the guard's inert stub and the element it
    // creates is not a happy-dom node. Restored below so nothing leaks between tests.
    const priorHtmlElement = Reflect.get(globalThis, "HTMLElement");
    Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
    try {
      return {
        window,
        global: evaluate(window, window.document, window.customElements, window.HTMLElement),
      };
    } finally {
      if (priorHtmlElement === undefined) Reflect.deleteProperty(globalThis, "HTMLElement");
      else Reflect.set(globalThis, "HTMLElement", priorHtmlElement);
    }
  }

  test("assigns the Pinbox global and registers the element when executed", async () => {
    const source = await Bun.file(dist("toolbar.iife.js")).text();
    expect(source).toMatch(/^var Pinbox = /);

    const { window, global } = await evaluateBundle();
    expect(typeof global.init).toBe("function");
    expect(window.customElements.get("pinbox-toolbar")).toBeDefined();
    await window.happyDOM.close();
  });

  // The global IS the module namespace of the iife entry — whatever that entry exports lands
  // directly on `window.Pinbox`. Pointing it at src/index.ts (which exports a `Pinbox` object)
  // therefore produced `Pinbox.Pinbox.init(…)`; src/iife.ts exists to keep the surface flat.
  // These two assertions are the contract the README documents, and are a BREAKING change once
  // the CDN path is published — hence a test, not a comment.
  test("exposes the API flat — Pinbox.init, never Pinbox.Pinbox.init", async () => {
    const { window, global } = await evaluateBundle();
    expect(global.Pinbox).toBeUndefined();
    expect(typeof global.defineToolbarElement).toBe("function");
    await window.happyDOM.close();
  });

  test("Pinbox.init mounts the toolbar into the host page", async () => {
    const { window, global } = await evaluateBundle();
    global.init?.({ endpoint: "http://127.0.0.1:4319" });
    expect(window.document.querySelector("pinbox-toolbar")).not.toBeNull();
    await window.happyDOM.close();
  });

  test("is a self-contained bundle — no bare imports survive", async () => {
    const source = await Bun.file(dist("toolbar.iife.js")).text();
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
