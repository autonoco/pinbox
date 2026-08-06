// OpenClaw adapter tests — a fake `openclaw` bin on a PATH-prepended temp dir records
// argv. The point is the exact verified push:
//   openclaw system event --mode next-heartbeat --session-key <k> --text <payload>
// — never `openclaw agent --message` (interrupt-not-join).
import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import type { Session } from "../sessions.ts";
import type { PinStore, StoredEvent } from "../store.ts";
import { openStore } from "../store.ts";
import { createOpenclawAdapter } from "./openclaw.ts";

const NOW = "2026-08-04T12:00:00.000Z";
const FIXTURE = new URL("./fixtures/fake-agent.ts", import.meta.url).pathname;
const ORIGINAL_PATH = process.env["PATH"] ?? "";

const input = {
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

type LogEntry = { argv: string[]; cwd: string };

type Harness = { root: string; logPath: string; readLog(): Promise<LogEntry[]> };

const roots: string[] = [];

/** Temp root with bin/openclaw (sh shim exec'ing the fake-agent fixture) on PATH. */
async function makeHarness(): Promise<Harness> {
  const root = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-openclaw-${crypto.randomUUID()}`;
  roots.push(root);
  const binDir = `${root}/bin`;
  const logPath = `${root}/log.jsonl`;
  await $`mkdir -p ${binDir}`.quiet();
  const shim = `${binDir}/openclaw`;
  await Bun.write(shim, `#!/bin/sh\nexec bun ${FIXTURE} "$@"\n`);
  await $`chmod +x ${shim}`.quiet();
  process.env["PATH"] = `${binDir}:${ORIGINAL_PATH}`;
  process.env["PINBOX_FAKE_AGENT_LOG"] = logPath;
  return {
    root,
    logPath,
    async readLog(): Promise<LogEntry[]> {
      const file = Bun.file(logPath);
      if (!(await file.exists())) return [];
      return (await file.text())
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as LogEntry);
    },
  };
}

afterEach(async () => {
  process.env["PATH"] = ORIGINAL_PATH;
  delete process.env["PINBOX_FAKE_AGENT_LOG"];
  delete process.env["PINBOX_FAKE_AGENT_EXIT"];
  for (const root of roots.splice(0)) await $`rm -rf ${root}`.quiet();
});

function makeSession(agent: string, over: Partial<Session> = {}): Session {
  const base: Session = {
    id: "ses_aaaaaaaaaa",
    agent,
    key: "claw-key-1",
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
  return { ...base, ...over };
}

/** Fresh store with one pin and a human reply; returns the reply event. */
function replyEvent(store: PinStore, text = "also fix hover"): StoredEvent {
  const pin = store.createPin(structuredClone(input), {});
  store.addThreadMessage(pin.id, "human", text);
  const event = store.eventsAfter(0).at(-1);
  if (event === undefined) throw new Error("no events");
  return event;
}

describe("deliver", () => {
  test("pin.created pushes the EXACT verified command with the injection context as --text", async () => {
    const h = await makeHarness();
    const store = openStore(":memory:");
    store.createPin(structuredClone(input), {});
    const event = store.eventsAfter(0).at(0);
    if (event === undefined) throw new Error("no events");
    const adapter = createOpenclawAdapter({ getPin: (id) => store.getPin(id) });
    await adapter.deliver(event, makeSession("openclaw"));

    const entries = await h.readLog();
    expect(entries).toHaveLength(1);
    const argv = entries.at(0)?.argv ?? [];
    expect(argv.slice(0, 6)).toEqual([
      "system",
      "event",
      "--mode",
      "next-heartbeat",
      "--session-key",
      "claw-key-1",
    ]);
    expect(argv.at(6)).toBe("--text");
    const payload = argv.at(7) ?? "";
    expect(argv).toHaveLength(8);
    expect(payload).toContain("Pinbox: 1 open pin(s)");
    expect(payload).toContain("button is cut off");
    store.close();
  });

  test("human reply pushes the fenced reply prompt to the same session key", async () => {
    const h = await makeHarness();
    const store = openStore(":memory:");
    const event = replyEvent(store);
    const adapter = createOpenclawAdapter({ getPin: (id) => store.getPin(id) });
    await adapter.deliver(event, makeSession("openclaw", { key: "claw-key-2" }));

    const argv = (await h.readLog()).at(0)?.argv ?? [];
    expect(argv.at(5)).toBe("claw-key-2"); // sticky key
    const payload = argv.at(7) ?? "";
    expect(payload).toContain("```\nalso fix hover\n```"); // reply fenced as data
    expect(payload).toContain("button is cut off");
    store.close();
  });

  test("non-zero exit rejects — retryable, NOT E_SESSION_GONE", async () => {
    const h = await makeHarness();
    process.env["PINBOX_FAKE_AGENT_EXIT"] = "3";
    const store = openStore(":memory:");
    const event = replyEvent(store);
    const adapter = createOpenclawAdapter({ getPin: (id) => store.getPin(id) });
    const error: unknown = await adapter
      .deliver(event, makeSession("openclaw"))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exited 3");
    // A failed push proves nothing about the session — the queue retries with backoff.
    expect((error as Error).message.startsWith("E_SESSION_GONE")).toBe(false);
    expect(await h.readLog()).toHaveLength(1);
    store.close();
  });
});

describe("matches", () => {
  test("openclaw session with the binary on PATH matches", async () => {
    await makeHarness();
    expect(createOpenclawAdapter().matches(makeSession("openclaw"))).toBe(true);
  });

  test("any other agent never matches", async () => {
    await makeHarness();
    const adapter = createOpenclawAdapter();
    expect(adapter.matches(makeSession("claude"))).toBe(false);
    expect(adapter.matches(makeSession("codex"))).toBe(false);
  });

  test("binary missing from PATH never matches", async () => {
    const h = await makeHarness();
    process.env["PATH"] = h.root; // no bin dir — no openclaw anywhere on PATH
    expect(createOpenclawAdapter().matches(makeSession("openclaw"))).toBe(false);
  });

  test("the command seam replaces the probed binary", async () => {
    await makeHarness();
    const adapter = createOpenclawAdapter({ command: ["definitely-not-on-path"] });
    expect(adapter.matches(makeSession("openclaw"))).toBe(false);
  });
});
