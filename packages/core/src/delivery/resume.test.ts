// Resume adapter tests — a real fake-agent fixture behind a `claude` sh shim in a
// PATH-prepended temp bin dir. Deep-dive §1.8's two measured rules are the point:
// (a) detached group + kill(-pid) on timeout reaps grandchildren, (b) drain both
// pipes to EOF before awaiting exit. Sticky rule 2: argv carries the SAME session key.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import type { Session } from "../sessions.ts";
import type { PinStore, StoredEvent } from "../store.ts";
import { openStore } from "../store.ts";
import { createResumeAdapter, killGroup, RESUME_COMMANDS } from "./resume.ts";

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

type Harness = {
  root: string;
  binDir: string;
  logPath: string;
  cwd: string;
  readLog(): Promise<LogEntry[]>;
};

const roots: string[] = [];

/** Temp root with bin/claude (sh shim exec'ing the fixture), a project cwd, a log path. */
async function makeHarness(shimArgs = ""): Promise<Harness> {
  const root = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-resume-${crypto.randomUUID()}`;
  roots.push(root);
  const binDir = `${root}/bin`;
  const cwd = `${root}/project`;
  const logPath = `${root}/log.jsonl`;
  await $`mkdir -p ${binDir} ${cwd}`.quiet();
  const shim = `${binDir}/claude`;
  await Bun.write(shim, `#!/bin/sh\nexec bun ${FIXTURE} ${shimArgs} "$@"\n`);
  await $`chmod +x ${shim}`.quiet();
  process.env["PATH"] = `${binDir}:${ORIGINAL_PATH}`;
  process.env["PINBOX_FAKE_AGENT_LOG"] = logPath;
  return {
    root,
    binDir,
    logPath,
    cwd,
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
  delete process.env["PINBOX_FAKE_AGENT_GRANDCHILD"];
  for (const root of roots.splice(0)) await $`rm -rf ${root}`.quiet();
});

/** A pid nothing owns — the unit tests never pass these signals to the real kill(2). */
const FAKE_PID = 0x7fff_fffe;

type SignalSpy = {
  calls(): Array<[number, string | number | undefined]>;
  sent(): Array<string | number | undefined>;
  restore(): void;
};

/**
 * Record every process.kill the adapter makes. `passthrough` forwards to the real
 * kill(2) so a spawned child still dies; the unit tests leave it off so a synthetic
 * pid is never signalled for real.
 */
function spyOnGroupSignals(passthrough = false): SignalSpy {
  const calls: Array<[number, string | number | undefined]> = [];
  const real = process.kill.bind(process);
  const spy = spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal?: string | number,
  ): true => {
    calls.push([pid, signal]);
    if (passthrough) real(pid, signal as never);
    return true;
  }) as typeof process.kill);
  return {
    calls: () => calls,
    sent: () => calls.map(([, signal]) => signal),
    restore: () => {
      spy.mockRestore();
    },
  };
}

function makeSession(agent: string, over: Partial<Session> = {}): Session {
  const base: Session = {
    id: "ses_aaaaaaaaaa",
    agent,
    key: "sess-key-1",
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

describe("RESUME_COMMANDS", () => {
  test("claude / codex / hermes argv shapes, key and prompt in place", () => {
    expect(RESUME_COMMANDS["claude"]?.("k1", "p1")).toEqual([
      "claude",
      "--resume",
      "k1",
      "-p",
      "p1",
    ]);
    expect(RESUME_COMMANDS["codex"]?.("k1", "p1")).toEqual(["codex", "exec", "resume", "k1", "p1"]);
    expect(RESUME_COMMANDS["hermes"]?.("k1", "p1")).toEqual([
      "hermes",
      "--resume",
      "k1",
      "-p",
      "p1",
    ]);
  });
});

describe("deliver", () => {
  test("human reply resumes the SAME session key from the recorded cwd with the fenced text", async () => {
    const h = await makeHarness();
    const store = openStore(":memory:");
    const event = replyEvent(store);
    const adapter = createResumeAdapter({ getPin: (id) => store.getPin(id) });
    await adapter.deliver(event, makeSession("claude", { cwd: h.cwd }));

    const entries = await h.readLog();
    expect(entries).toHaveLength(1);
    const entry = entries.at(0);
    expect(entry?.argv.slice(0, 3)).toEqual(["--resume", "sess-key-1", "-p"]); // sticky key
    const prompt = entry?.argv.at(3) ?? "";
    expect(prompt).toContain("```\nalso fix hover\n```"); // reply fenced as data
    expect(prompt).toContain("button is cut off");
    // cwd honored (suffix compare: macOS tmp dirs realpath through /private).
    expect(entry?.cwd.endsWith(h.cwd.split("/").slice(-2).join("/"))).toBe(true);
    store.close();
  });

  test("pin.created delivers the injection context for that pin", async () => {
    const h = await makeHarness();
    const store = openStore(":memory:");
    store.createPin(structuredClone(input), {});
    const event = store.eventsAfter(0).at(0);
    if (event === undefined) throw new Error("no events");
    const adapter = createResumeAdapter({ getPin: (id) => store.getPin(id) });
    await adapter.deliver(event, makeSession("claude", { cwd: h.cwd }));

    const prompt = (await h.readLog()).at(0)?.argv.at(3) ?? "";
    expect(prompt).toContain("Pinbox: 1 open pin(s)");
    expect(prompt).toContain("button is cut off");
    store.close();
  });

  test("non-zero exit rejects with an E_SESSION_GONE-tagged error (resume refused)", async () => {
    const h = await makeHarness();
    process.env["PINBOX_FAKE_AGENT_EXIT"] = "2";
    const store = openStore(":memory:");
    const event = replyEvent(store);
    const adapter = createResumeAdapter({ getPin: (id) => store.getPin(id) });
    const error: unknown = await adapter
      .deliver(event, makeSession("claude", { cwd: h.cwd }))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.startsWith("E_SESSION_GONE:")).toBe(true);
    store.close();
  });

  test("timeout kills the WHOLE process group — the sleeping grandchild dies too", async () => {
    const h = await makeHarness("--hang");
    const gpidPath = `${h.root}/gpid`;
    process.env["PINBOX_FAKE_AGENT_GRANDCHILD"] = gpidPath;
    const store = openStore(":memory:");
    const event = replyEvent(store);
    // Generous timeout: the SIGTERM must land only after the fixture (bun cold-start
    // behind an sh shim) has spawned its grandchild and written the pid file — 300ms
    // raced that startup and flaked ~1 in 3 runs on a loaded machine.
    const adapter = createResumeAdapter({ timeoutMs: 1500, getPin: (id) => store.getPin(id) });
    await expect(adapter.deliver(event, makeSession("claude", { cwd: h.cwd }))).rejects.toThrow(
      /timed out/,
    );

    const gpid = Number.parseInt(await Bun.file(gpidPath).text(), 10);
    expect(Number.isInteger(gpid)).toBe(true);
    // kill(-pid) proof: poll past the SIGKILL escalation window, then assert dead.
    let dead = false;
    for (let i = 0; i < 30 && !dead; i++) {
      try {
        process.kill(gpid, 0);
        await Bun.sleep(100);
      } catch {
        dead = true;
      }
    }
    expect(dead).toBe(true);
    expect(() => process.kill(gpid, 0)).toThrow();
    store.close();
  }, 15_000); // 1.5s timeout + 2s SIGKILL escalation + poll must fit under the test deadline

  test("a timed-out child that exits on SIGTERM leaves no pending SIGKILL escalation", async () => {
    const h = await makeHarness("--hang");
    const store = openStore(":memory:");
    const event = replyEvent(store);
    const signals = spyOnGroupSignals(true);
    try {
      const adapter = createResumeAdapter({ timeoutMs: 1000, getPin: (id) => store.getPin(id) });
      await expect(adapter.deliver(event, makeSession("claude", { cwd: h.cwd }))).rejects.toThrow(
        /timed out/,
      );
      expect(signals.sent()).toContain("SIGTERM");
      // Past the escalation window: the child is long gone, so its pid is free for OS
      // reuse — a SIGKILL landing now would signal a group we no longer own.
      await Bun.sleep(2_600);
      expect(signals.sent()).not.toContain("SIGKILL");
    } finally {
      signals.restore();
      store.close();
    }
  }, 15_000);
});

describe("killGroup", () => {
  test("SIGTERMs the group and escalates to SIGKILL when the child ignores it", async () => {
    const signals = spyOnGroupSignals();
    try {
      killGroup(FAKE_PID, 25);
      expect(signals.calls()).toEqual([[-FAKE_PID, "SIGTERM"]]);
      await Bun.sleep(120);
      expect(signals.calls()).toEqual([
        [-FAKE_PID, "SIGTERM"],
        [-FAKE_PID, "SIGKILL"],
      ]);
    } finally {
      signals.restore();
    }
  });

  test("the returned cancel stops the escalation once the child has exited", async () => {
    const signals = spyOnGroupSignals();
    try {
      const cancel = killGroup(FAKE_PID, 25);
      cancel();
      await Bun.sleep(120);
      expect(signals.calls()).toEqual([[-FAKE_PID, "SIGTERM"]]);
    } finally {
      signals.restore();
    }
  });
});

describe("matches", () => {
  test("claude with recorded cwd and binary on PATH matches — even when ended", async () => {
    const h = await makeHarness();
    const adapter = createResumeAdapter();
    expect(adapter.matches(makeSession("claude", { cwd: h.cwd }))).toBe(true);
    // Liveness ordering is the router's job: resume targets ended sessions and escalations.
    expect(adapter.matches(makeSession("claude", { cwd: h.cwd, endedAt: NOW }))).toBe(true);
  });

  test("no recorded cwd never matches", async () => {
    await makeHarness();
    expect(createResumeAdapter().matches(makeSession("claude"))).toBe(false);
  });

  test("an agent outside the command map never matches", async () => {
    const h = await makeHarness();
    expect(createResumeAdapter().matches(makeSession("openclaw", { cwd: h.cwd }))).toBe(false);
    // The commands map is the seam: without a claude entry, claude does not match.
    const custom = createResumeAdapter({ commands: {} });
    expect(custom.matches(makeSession("claude", { cwd: h.cwd }))).toBe(false);
  });

  test("binary missing from PATH never matches", async () => {
    const h = await makeHarness();
    process.env["PATH"] = h.cwd; // empty dir — no claude anywhere on PATH
    expect(createResumeAdapter().matches(makeSession("claude", { cwd: h.cwd }))).toBe(false);
  });
});
