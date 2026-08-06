// Serve boot composition: the daemon wires the ONE dispatch call
// site — store.subscribe((e) => void router.dispatch(e)) — plus boot drainDue and the
// unref'd drain interval. Integration over a REAL spawned daemon (daemon.test.ts
// pattern): assertions read the deliveries ledger through a second, read-only
// connection to .pinbox/pinbox.db — the queue, not the process, is what we verify.

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { type HubState, readHubState, statePaths } from "../paths.ts";
import { validInput } from "./transcript-fixtures.ts";

// Under `bun test`, Bun.main is the TEST FILE — spawn the CLI entry explicitly.
const cliEntry = new URL("../main.ts", import.meta.url).pathname;

type Envelope<T> = { ok: boolean; data: T };

class DeliveryRowRaw {
  id!: number;
  event_seq!: number;
  session_id!: string | null;
  adapter!: string;
  status!: string;
}

class JsonRaw {
  json!: string;
}

async function waitFor<T>(probe: () => T | null | Promise<T | null>, what: string): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const found = await probe();
    if (found !== null) return found;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("serve boot composition (integration, real spawn)", () => {
  const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-serve-${crypto.randomUUID()}`;
  const projectDir = `${tmpRoot}/proj`;
  const savedEnv: Record<string, string | undefined> = {};
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let state: HubState;
  let baseUrl: string;
  let db: Database | null = null; // read-only second connection, opened lazily
  let sessionId: string;
  let pinId: string;

  const authed = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
    });

  const ledger = (): Database => {
    db ??= new Database(statePaths(projectDir).dbFile, { readonly: true });
    return db;
  };

  const hooksRow = (status: string): DeliveryRowRaw | null =>
    ledger()
      .query(
        "SELECT id, event_seq, session_id, adapter, status FROM deliveries WHERE adapter = 'hooks' AND status = ? ORDER BY id ASC",
      )
      .as(DeliveryRowRaw)
      .get(status);

  beforeAll(async () => {
    savedEnv["XDG_STATE_HOME"] = process.env["XDG_STATE_HOME"];
    savedEnv["PINBOX_IDLE_MS"] = process.env["PINBOX_IDLE_MS"];
    process.env["XDG_STATE_HOME"] = `${tmpRoot}/state`;
    process.env["PINBOX_IDLE_MS"] = "60000";
    await $`mkdir -p ${projectDir}`.quiet();

    proc = Bun.spawn([process.execPath, cliEntry, "serve", "--project", projectDir], {
      stdout: "ignore",
      stderr: "inherit",
      // Bun.spawn's default env is the STARTUP environ — the beforeAll mutations
      // (XDG_STATE_HOME, PINBOX_IDLE_MS) only reach the daemon via an explicit object.
      env: { ...process.env },
    });
    state = await waitFor(() => readHubState(statePaths(projectDir).stateFile), "hub.json");
    baseUrl = `http://127.0.0.1:${state.port}`;
    await waitFor(
      async () => ((await fetch(`${baseUrl}/health`).catch(() => null))?.ok ? true : null),
      "hub /health",
    );
  }, 30_000);

  afterAll(async () => {
    db?.close();
    try {
      proc?.kill("SIGTERM");
    } catch {
      // already gone — the SIGTERM test stopped it
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await $`rm -rf ${tmpRoot}`.quiet();
  });

  test("pin without agentSession lands a pending hooks delivery bound to the active session", async () => {
    const registered = await authed("/sessions", {
      method: "POST",
      body: JSON.stringify({ agent: "claude", key: "s1" }),
    });
    expect(registered.status).toBe(201);
    const session = ((await registered.json()) as Envelope<{ id: string }>).data;
    sessionId = session.id;
    expect(sessionId).toMatch(/^ses_[a-z0-9]{10}$/);

    const created = await authed("/pins", { method: "POST", body: JSON.stringify(validInput) });
    expect(created.status).toBe(201);
    const pin = ((await created.json()) as Envelope<{ id: string; agentSession?: unknown }>).data;
    pinId = pin.id;

    // The subscribe→dispatch wiring is the only thing that can write this row.
    const row = await waitFor(() => hooksRow("pending"), "pending hooks delivery row");
    expect(row.adapter).toBe("hooks");
    expect(row.status).toBe("pending");
    expect(row.session_id).toBe(sessionId);

    // Rule-1 persistence: the router bound the pin to s1 and persisted agentSession.
    const stored = ledger().query("SELECT json FROM pins WHERE id = ?").as(JsonRaw).get(pinId);
    expect(stored).not.toBeNull();
    const storedPin = JSON.parse((stored as JsonRaw).json) as { agentSession?: unknown };
    expect(storedPin.agentSession).toEqual({ agent: "claude", key: "s1" });
  }, 20_000);

  test("POST /sessions/:id/inject flips the pending row to delivered", async () => {
    const injected = await authed(`/sessions/${sessionId}/inject`, { method: "POST" });
    expect(injected.status).toBe(200);
    const body = ((await injected.json()) as Envelope<{ delivered: number }>).data;
    expect(body.delivered).toBeGreaterThanOrEqual(1);

    const row = await waitFor(() => hooksRow("delivered"), "delivered hooks delivery row");
    expect(row.session_id).toBe(sessionId);
    expect(hooksRow("pending")).toBeNull();
  }, 20_000);

  test("SIGTERM stops the daemon and cleans up its state files", async () => {
    process.kill(state.pid, "SIGTERM");
    await waitFor(
      async () =>
        (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(250) }).catch(() => null))
          ? null
          : true,
      "hub to stop answering",
    );
    const paths = statePaths(projectDir);
    await waitFor(
      async () => ((await Bun.file(paths.stateFile).exists()) ? null : true),
      "hub.json removal",
    );
    expect(await Bun.file(paths.serverJson).exists()).toBe(false);
  }, 20_000);
});
