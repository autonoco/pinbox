// Structural gate for the native OpenClaw plugin. Shapes asserted below were read off
// an installed OpenClaw (2026.7.1), not inferred.
//
// The facts this suite pins:
// - `openclaw.plugin.json` requires `id` and `configSchema`. The native manifest has
//   no `bin` and no `mcpServers` key — tools are registered in-process by the entry
//   module, so adding either is dead weight.
// - The entry module's `gateway_start` handler is the only live-injection path;
//   injections are keyed by `idempotencyKey` = "pin:<pinId>:<seq>", which is what
//   makes re-injecting an open pin every turn safe.
//
// Runs under root `bun test`. Live `openclaw plugins validate` gate is skipped when
// the CLI is absent.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import entry from "./src/index.ts";
import type {
  GatewayStartEvent,
  OpenClawPluginApi,
  PluginTool,
  SessionLifecycleEvent,
} from "./src/openclaw-api";

const pluginDir = import.meta.dir;
const repoRoot = new URL("../..", `file://${pluginDir}/`).pathname.replace(/\/$/, "");

// The literal source text the plugin must contain. In a plain string `${…}` is inert, which is
// exactly what we want — the rule below exists to catch an accidental template, not a deliberate one.
// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on literal source text
const IDEMPOTENCY_LITERAL = "pin:${pin.id}:${lastSeq}";

describe("openclaw.plugin.json", () => {
  test("parses with required id and configSchema; skills lists the skills dir", async () => {
    const manifest = (await Bun.file(`${pluginDir}/openclaw.plugin.json`).json()) as Record<
      string,
      unknown
    >;
    expect(manifest["id"]).toBe("pinbox");
    expect(typeof manifest["version"]).toBe("string");
    const configSchema = manifest["configSchema"] as Record<string, unknown>;
    expect(configSchema["type"]).toBe("object");
    const properties = configSchema["properties"] as Record<string, unknown>;
    expect((properties["pollMs"] as Record<string, unknown>)["type"]).toBe("number");
    expect(manifest["skills"]).toEqual(["skills"]);
  });
});

describe("src/index.ts guest artifact", () => {
  test("runtime imports are node:-prefixed only (guest rule)", async () => {
    const source = await Bun.file(`${pluginDir}/src/index.ts`).text();
    const importLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      if (line.startsWith("import type ")) continue; // erased — types carry no runtime
      const specifier = /from\s+"([^"]+)"/.exec(line)?.[1] ?? /^import\s+"([^"]+)"/.exec(line)?.[1];
      expect(specifier).toBeDefined();
      expect(specifier?.startsWith("node:")).toBe(true);
    }
  });

  test("contains the literal idempotencyKey construction", async () => {
    const source = await Bun.file(`${pluginDir}/src/index.ts`).text();
    expect(source).toContain("idempotencyKey");
    expect(source).toContain(IDEMPOTENCY_LITERAL);
  });

  test("bundled skill file exists (synced by skillgen)", async () => {
    expect(await Bun.file(`${pluginDir}/skills/pinbox/SKILL.md`).exists()).toBe(true);
  });

  // Commander rejects unknown options, and this plugin swallows that rejection into a
  // warn. So a flag rename in the CLI would break session binding silently. Pin the
  // pairing: the flags used here must be the flags the CLI declares.
  test("session register is invoked with the flags the CLI declares", async () => {
    const source = await Bun.file(`${pluginDir}/src/index.ts`).text();
    const registerFn = /async function registerSession[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
    expect(registerFn).toContain('"--agent"');
    expect(registerFn).toContain('"--key"');

    const cliSource = await Bun.file(
      `${import.meta.dir}/../../packages/cli/src/commands/session.ts`,
    ).text();
    expect(cliSource).toContain("--agent <name>");
    expect(cliSource).toContain("--key <key>");
  });
});

type Hooks = {
  gateway_start: ((event: GatewayStartEvent) => void | Promise<void>)[];
  session: ((event: SessionLifecycleEvent) => void | Promise<void>)[];
};

/** Minimal gateway double: records hooks, never runs a real poll tick. */
function fakeApi(pollMs: number): { api: OpenClawPluginApi; hooks: Hooks; tools: PluginTool[] } {
  const hooks: Hooks = { gateway_start: [], session: [] };
  const tools: PluginTool[] = [];
  const api = {
    pluginConfig: { pollMs },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerHook: (event: string, handler: never) => {
      if (event === "gateway_start") hooks.gateway_start.push(handler);
      else hooks.session.push(handler);
    },
    registerTool: (tool: PluginTool) => {
      tools.push(tool);
    },
    session: {
      workflow: {
        enqueueNextTurnInjection: async () => ({ enqueued: true, id: "i", sessionKey: "s" }),
      },
    },
  } as unknown as OpenClawPluginApi;
  return { api, hooks, tools };
}

describe("gateway_start poller lifecycle", () => {
  afterEach(() => {
    // Restore the timer globals the spies below replace.
    (globalThis.setInterval as unknown as { mockRestore?: () => void }).mockRestore?.();
    (globalThis.clearInterval as unknown as { mockRestore?: () => void }).mockRestore?.();
  });

  test("a gateway restart-in-place clears the old poller instead of doubling it", () => {
    const created: number[] = [];
    const cleared: number[] = [];
    let next = 1;
    spyOn(globalThis, "setInterval").mockImplementation(((): number => {
      const id = next++;
      created.push(id);
      return id;
    }) as never);
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number): void => {
      cleared.push(id);
    }) as never);

    const { api, hooks } = fakeApi(5_000);
    entry.register(api);
    const start = hooks.gateway_start[0];
    expect(start).toBeDefined();
    start?.({ port: 1 });
    start?.({ port: 1 }); // restart in place / hot reload: the gateway fires it again

    expect(created).toHaveLength(2);
    const live = created.filter((id) => !cleared.includes(id));
    expect(live).toHaveLength(1); // exactly one poller survives, never two
    expect(live).toEqual([created.at(-1) as number]);
  });
});

describe("typecheck gate", () => {
  test("bunx tsc --noEmit -p plugins/pinbox-openclaw exits 0", async () => {
    const result = await $`bunx tsc --noEmit -p plugins/pinbox-openclaw`
      .cwd(repoRoot)
      .nothrow()
      .quiet();
    expect(result.exitCode).toBe(0);
  }, 60_000);
});

describe("live CLI gate", () => {
  test.skipIf(!Bun.which("openclaw"))(
    "openclaw plugins validate exits 0",
    async () => {
      const result = await $`openclaw plugins validate --root plugins/pinbox-openclaw`
        .cwd(repoRoot)
        .nothrow()
        .quiet();
      expect(result.exitCode).toBe(0);
    },
    30_000,
  );
});
