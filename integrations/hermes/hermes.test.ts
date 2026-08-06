// Structural gate for the Hermes integration. Shapes asserted below were read off an
// installed Hermes, not inferred. Runs under root `bun test`.
//
// The trap this suite exists to catch: Hermes's loader reads plugin.yaml ONLY, and a
// `hooks:` key there parses fine and wires nothing. A shipped Hermes plugin
// (`security-guidance`) has exactly that bug. Hooks must be registered from
// `register(ctx)` in Python; anything declared in YAML is inert.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { $ } from "bun";

const hermesDir = import.meta.dir;

// The ONLY manifest keys Hermes parses. Anything else is dead weight at best and the
// silent-failure trap above at worst.
const PARSED_KEYS = [
  "name",
  "version",
  "description",
  "author",
  "requires_env",
  "provides_tools",
  "provides_hooks",
  "kind",
  "manifest_version",
];

// Stdlib-only rule: Hermes does no dependency resolution at install and the package
// runs inside Hermes's own venv, so a third-party import is an ImportError at load
// time. Relative imports within the package are fine.
const STDLIB_ALLOWLIST = ["__future__", "json", "os", "pathlib", "subprocess", "sys", "typing"];
const PY_FILES = ["__init__.py", "schemas.py", "tools.py"];

describe("plugin.yaml", () => {
  const load = async (): Promise<Record<string, unknown>> =>
    Bun.YAML.parse(await Bun.file(`${hermesDir}/plugin.yaml`).text()) as Record<string, unknown>;

  test("parses and its key set is within the parsed-keys list", async () => {
    const doc = await load();
    expect(doc["name"]).toBe("pinbox");
    expect(doc["manifest_version"]).toBe(1);
    for (const key of Object.keys(doc)) {
      expect(PARSED_KEYS).toContain(key);
    }
  });

  test("has NO hooks key (unread by the loader — the silent-failure trap)", async () => {
    const doc = await load();
    expect(Object.keys(doc)).not.toContain("hooks");
  });

  test("provides_hooks declares pre_llm_call and provides_tools the three pin tools", async () => {
    const doc = await load();
    expect(doc["provides_hooks"]).toEqual(["pre_llm_call"]);
    expect(doc["provides_tools"]).toEqual(["pin_list", "pin_reply", "pin_resolve"]);
  });
});

describe("python package", () => {
  test("__init__.py defines register(ctx)", async () => {
    const source = await Bun.file(`${hermesDir}/__init__.py`).text();
    expect(source).toContain("def register(ctx)");
  });

  test("imports stay within the stdlib allowlist (guest rule: stdlib only)", async () => {
    for (const file of PY_FILES) {
      const source = await Bun.file(`${hermesDir}/${file}`).text();
      const importLines = source
        .split("\n")
        .filter((line) => /^\s*(import|from)\s/.test(line))
        .map((line) => line.trim());
      for (const line of importLines) {
        const match = /^(?:from|import)\s+([A-Za-z0-9_.]+)/.exec(line);
        expect(match).not.toBeNull();
        const moduleName = match?.[1] ?? "";
        const root = moduleName.split(".")[0] ?? "";
        // `from . import tools` — package-relative, always allowed.
        const relative = moduleName.startsWith(".") || line.startsWith("from .");
        if (!relative) expect(STDLIB_ALLOWLIST).toContain(root);
      }
    }
  });

  test.skipIf(!Bun.which("python3"))("py_compile passes on all three files", async () => {
    // cfile goes to a temp dir so the suite never writes __pycache__ into the repo.
    const compileSnippet =
      "import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)";
    for (const file of PY_FILES) {
      const cfile = `${tmpdir()}/pinbox-hermes-${file}.pyc`;
      const result = await $`python3 -c ${compileSnippet} ${hermesDir}/${file} ${cfile}`
        .nothrow()
        .quiet();
      expect(result.exitCode).toBe(0);
    }
  });
});

describe("companion files", () => {
  test("after-install.md covers pinbox init and the gateway restart", async () => {
    const text = await Bun.file(`${hermesDir}/after-install.md`).text();
    expect(text).toContain("pinbox init");
    expect(text).toContain("hermes gateway restart");
  });

  test("bundled skill file exists (synced by skillgen)", async () => {
    expect(await Bun.file(`${hermesDir}/skills/pinbox/SKILL.md`).exists()).toBe(true);
  });
});
