// e2e — the real delivery round trip over the COMPILED binary
// (packages/cli/dist/pinbox), in mkdtemp isolation per loop.test.ts (HOME/XDG redirect,
// PINBOX_IDLE_MS, state-file token for raw HTTP). Unlike the loop test's runtime-free
// PATH, this PATH prepends e2e/fixtures (a `claude` sh shim → fake-claude.ts) and
// carries bun for that fixture only — the resume adapter must find `claude` on the
// daemon's PATH and spawn it.
// Proves, in order: register → pin → same-session inject; no agent echo; sticky reply
// to the BOUND session (rule 2 beats recency); resume-spawn of the SAME session key
// after the session ends; commit-trailer resolution with the SHA attached.
import { afterAll, beforeAll, expect, test } from "bun:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const BINARY = `${repoRoot}packages/cli/dist/pinbox`;
const FIXTURES = `${repoRoot}e2e/fixtures`;

// System tools + the fake-agent shim dir + bun (for the shim only — see fixtures/claude).
const bunDir = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
const E2E_PATH = `${FIXTURES}:${bunDir}:/usr/bin:/bin`;

// Drain interval is 15s; every poll caps at 30s.
const POLL_CAP_MS = 30_000;

let tmp = "";
let projectDir = "";
let claudeLogDir = "";
let env: {
  PATH: string;
  HOME: string;
  XDG_STATE_HOME: string;
  PINBOX_IDLE_MS: string;
  PINBOX_E2E_CLAUDE_LOG_DIR: string;
};
let hub: { pid: number; port: number; token: string };
let pinId = "";
let sessionOneId = "";

// Same shape as the schema fixtures (packages/core/src/schema.test.ts); no agentSession —
// rule 1 must bind the pin to the active registered session.
const validInput = {
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
};

/** Claude-shaped hook payloads (research §1 shared schema) piped into `--hook` stdin. */
function hookPayload(sessionId: string, event: string): string {
  return JSON.stringify({ session_id: sessionId, cwd: projectDir, hook_event_name: event });
}

beforeAll(async () => {
  tmp = (await Bun.$`mktemp -d`.text()).trim();
  projectDir = `${tmp}/project`;
  claudeLogDir = `${tmp}/claude-log`;
  env = {
    PATH: E2E_PATH,
    HOME: `${tmp}/home`,
    XDG_STATE_HOME: `${tmp}/state`,
    PINBOX_IDLE_MS: "120000",
    PINBOX_E2E_CLAUDE_LOG_DIR: claudeLogDir,
  };
  await Bun.$`mkdir -p ${projectDir} ${env.HOME} ${claudeLogDir}`.quiet();
  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir, env });
});

afterAll(async () => {
  // Belt and braces: if a step died before the flow finished, reap the daemon.
  const state = await readHubState();
  if (state !== null) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (tmp !== "") await Bun.$`rm -rf ${tmp}`.quiet();
});

test("compiled binary and the fake-claude fixture are in place", async () => {
  expect(
    await Bun.file(BINARY).exists(),
    `missing ${BINARY} — run \`bun run build\` first (ci:validate builds before testing)`,
  ).toBe(true);
  expect(Bun.which("claude", { PATH: E2E_PATH })).toBe(`${FIXTURES}/claude`);
});

test("1. register → pin → same-session inject binds and delivers to e2e-s1", async () => {
  // SessionStart hook: side-effect only — registers, prints nothing.
  const register = await run(["session", "register", "--hook"], {
    stdin: hookPayload("e2e-s1", "SessionStart"),
    extraEnv: { CLAUDECODE: "1" },
  });
  expect(register.code).toBe(0);
  expect(register.stdout.trim()).toBe("");

  const list = await run(["session", "list", "--json"]);
  expect(list.code).toBe(0);
  const sessions = envelopeData<{ id: string; agent: string; key: string }[]>(list.stdout);
  expect(sessions.map((s) => ({ agent: s.agent, key: s.key }))).toEqual([
    { agent: "claude", key: "e2e-s1" },
  ]);
  sessionOneId = sessions[0]?.id ?? "";
  expect(sessionOneId).toMatch(/^ses_[a-z0-9]{10}$/);

  // The daemon's state file carries the token for the raw-HTTP (toolbar) path.
  const state = await readHubState();
  if (state === null) throw new Error("hub.json not found under XDG_STATE_HOME");
  hub = state;

  // A pin created over raw HTTP, with NO agentSession in the body.
  const created = await fetch(`http://127.0.0.1:${hub.port}/pins`, {
    method: "POST",
    headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
    body: JSON.stringify(validInput),
  });
  expect(created.status).toBe(201);
  const createdEnvelope = (await created.json()) as { ok: boolean; data: { id: string } };
  expect(createdEnvelope.ok).toBe(true);
  pinId = createdEnvelope.data.id;
  expect(pinId).toMatch(/^pin_[a-z0-9]{10}$/);

  // The router dispatches post-commit: wait for the hooks row to reach e2e-s1's queue.
  expect(await waitForPending("e2e-s1", 1), "pin.created never queued for e2e-s1").toBe(true);

  // UserPromptSubmit hook pull: the byte-shaped injection contract, pin text inside.
  const inject = await run(["session", "inject", "--hook"], {
    stdin: hookPayload("e2e-s1", "UserPromptSubmit"),
    extraEnv: { CLAUDECODE: "1" },
  });
  expect(inject.code).toBe(0);
  const output = JSON.parse(inject.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  expect(output.hookSpecificOutput.additionalContext).toContain(pinId);
  expect(output.hookSpecificOutput.additionalContext).toContain("button is cut off");

  // Rule 1 bound the pin to the active session, persisted on the pin itself.
  const show = await run(["show", pinId, "--json"]);
  expect(show.code).toBe(0);
  const { pin } = envelopeData<{ pin: { agentSession?: { agent: string; key: string } } }>(
    show.stdout,
  );
  expect(pin.agentSession?.agent).toBe("claude");
  expect(pin.agentSession?.key).toBe("e2e-s1");
}, 60_000);

test("2. no echo: an agent reply is never delivered back to the authoring session", async () => {
  const reply = await run(["reply", pinId, "on it", "--as", "agent"]);
  expect(reply.code).toBe(0);
  // Dispatch runs post-commit on the daemon; give it a beat, then require silence.
  await Bun.sleep(500);
  const pending = await run(["session", "pending", "--hook"], {
    stdin: hookPayload("e2e-s1", "Stop"),
    extraEnv: { CLAUDECODE: "1" },
  });
  expect(pending.code).toBe(0);
  expect(pending.stdout).toBe(""); // rule 3 — empty stdout must not hold the agent
}, 30_000);

test("3. sticky reply: a human reply routes to the BOUND session, not the most recent", async () => {
  // e2e-s2 registers and becomes the most recently seen session.
  const register = await run(["session", "register", "--hook"], {
    stdin: hookPayload("e2e-s2", "SessionStart"),
    extraEnv: { CLAUDECODE: "1" },
  });
  expect(register.code).toBe(0);

  const reply = await run(["reply", pinId, "also fix hover"]);
  expect(reply.code).toBe(0);

  // Rule 2 beats recency: the pin's bound session e2e-s1 gets the pending delivery…
  expect(await waitForPending("e2e-s1", 1), "human reply never queued for e2e-s1").toBe(true);
  const pendingOne = await run(["session", "pending", "--hook"], {
    stdin: hookPayload("e2e-s1", "Stop"),
    extraEnv: { CLAUDECODE: "1" },
  });
  expect(pendingOne.code).toBe(0);
  expect(pendingOne.stdout).toContain(pinId);

  // …and e2e-s2, though most recent, gets nothing.
  const pendingTwo = await run(["session", "pending", "--hook"], {
    stdin: hookPayload("e2e-s2", "Stop"),
    extraEnv: { CLAUDECODE: "1" },
  });
  expect(pendingTwo.code).toBe(0);
  expect(pendingTwo.stdout).toBe("");
}, 60_000);

test("4. resume path: an ended session is resumed under the SAME key by the fake claude", async () => {
  // End e2e-s1 over raw HTTP — the process is gone, the binding stays.
  const ended = await fetch(`http://127.0.0.1:${hub.port}/sessions/${sessionOneId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${hub.token}` },
  });
  expect(ended.status).toBe(200);

  const reply = await run(["reply", pinId, "hover still broken"]);
  expect(reply.code).toBe(0);

  // Within the drain interval the resume adapter spawns `claude` from PATH.
  const spawned = await waitFor(async () => (await resumeInvocations()).length > 0, POLL_CAP_MS);
  expect(spawned, "fake claude was never spawned by the resume adapter").toBe(true);

  const invocation = (await resumeInvocations()).find((entry) =>
    entry.argv.some((arg) => arg.includes("hover still broken")),
  );
  if (invocation === undefined) throw new Error("no claude invocation carried the reply prompt");
  // Same session key, resumed print-mode — never a fresh session.
  expect(invocation.argv.slice(0, 3)).toEqual(["--resume", "e2e-s1", "-p"]);
  const prompt = invocation.argv[3] ?? "";
  expect(prompt).toContain(pinId);
  expect(prompt).toContain("```\nhover still broken\n```"); // reply text fenced as data
  expect(invocation.cwd.endsWith("/project")).toBe(true); // resumed from the recorded cwd
}, 60_000);

test("5. trailer: `Resolves: <id>` in a commit resolves the pin with the SHA attached", async () => {
  const commit = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.email=e2e@pinbox.dev",
      "-c",
      "user.name=pinbox e2e",
      "commit",
      "--allow-empty",
      "-m",
      `fix: cta — Resolves: ${pinId}`,
    ],
    { cwd: projectDir, env },
  );
  expect(commit.success).toBe(true);
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: projectDir, env })
    .stdout.toString()
    .trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);

  const trailer = await run(["session", "trailer", "--json"]);
  expect(trailer.code).toBe(0);
  const outcome = envelopeData<{ resolved: string[]; skipped: string[] }>(trailer.stdout);
  expect(outcome.resolved).toEqual([pinId]);
  expect(outcome.skipped).toEqual([]);

  const show = await run(["show", pinId, "--json"]);
  expect(show.code).toBe(0);
  const { pin } = envelopeData<{ pin: { status: string; resolution?: { commit?: string } } }>(
    show.stdout,
  );
  expect(pin.status).toBe("resolved");
  expect(pin.resolution?.commit).toBe(sha);

  // Re-run skips silently: amend/rebase re-fires are idempotent.
  const rerun = await run(["session", "trailer", "--json"]);
  expect(rerun.code).toBe(0);
  expect(envelopeData<{ resolved: string[]; skipped: string[] }>(rerun.stdout)).toEqual({
    resolved: [],
    skipped: [pinId],
  });

  const summary = await run(["summary", "--json"]);
  expect(summary.code).toBe(0);
  const counts = envelopeData<{ open: number; resolved: number; sessions: number }>(summary.stdout);
  expect(counts.resolved).toBe(1);
  expect(counts.open).toBe(0);
  expect(counts.sessions).toBeGreaterThanOrEqual(1); // e2e-s2 is still active
}, 60_000);

/** Run the compiled binary in the temp project, optionally with stdin and extra env. */
async function run(
  args: string[],
  opts?: { stdin?: string; extraEnv?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BINARY, ...args], {
    cwd: projectDir,
    env: { ...env, ...opts?.extraEnv },
    stdin: opts?.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function envelopeData<T>(stdout: string): T {
  let parsed: { ok: boolean; data: T };
  try {
    parsed = JSON.parse(stdout) as { ok: boolean; data: T };
  } catch {
    throw new Error(`stdout is not a JSON envelope: ${JSON.stringify(stdout)}`);
  }
  if (parsed.ok !== true) throw new Error(`envelope not ok: ${stdout}`);
  return parsed.data;
}

/** Poll `session pending --json` for a (claude, key) session until `count` is reached. */
async function waitForPending(key: string, count: number): Promise<boolean> {
  return waitFor(async () => {
    const pending = await run(["session", "pending", "--agent", "claude", "--key", key, "--json"]);
    if (pending.code !== 0) return false;
    return envelopeData<{ count: number }>(pending.stdout).count >= count;
  }, POLL_CAP_MS);
}

/** Every fake-claude invocation so far — one json file per spawn (see fixtures). */
async function resumeInvocations(): Promise<{ argv: string[]; cwd: string }[]> {
  const glob = new Bun.Glob("claude-*.json");
  const entries: { argv: string[]; cwd: string }[] = [];
  for (const name of glob.scanSync({ cwd: claudeLogDir })) {
    entries.push(
      (await Bun.file(`${claudeLogDir}/${name}`).json()) as {
        argv: string[];
        cwd: string;
      },
    );
  }
  return entries;
}

/** The daemon's state file under XDG_STATE_HOME (project id is hashed — glob). */
async function readHubState(): Promise<{ pid: number; port: number; token: string } | null> {
  const glob = new Bun.Glob("pinbox/*/hub.json");
  let matches: string[];
  try {
    matches = [...glob.scanSync({ cwd: env.XDG_STATE_HOME, dot: true })];
  } catch {
    return null; // state dir not created yet
  }
  const first = matches[0];
  if (first === undefined) return null;
  try {
    return (await Bun.file(`${env["XDG_STATE_HOME"]}/${first}`).json()) as {
      pid: number;
      port: number;
      token: string;
    };
  } catch {
    return null;
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(100);
  }
  return condition();
}
