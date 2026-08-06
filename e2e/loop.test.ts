// e2e — the full loop over the COMPILED binary (packages/cli/dist/pinbox).
// Runs the shipped artifact by absolute path in a mkdtemp project, with HOME and
// XDG_STATE_HOME redirected into the temp dir and a PATH that contains NO bun and NO
// node — the standalone binary embeds its runtime, and proving that is the one thing
// e2e is uniquely positioned to do.
// Flow: `summary --json` auto-spawns the hub → server.json is port-only (no secret) →
// POST /pins over raw HTTP with the state-dir token → list / resolve / export / doctor
// through the binary → SIGTERM the daemon and watch it clean up its state files.
import { afterAll, beforeAll, expect, test } from "bun:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const BINARY = `${repoRoot}packages/cli/dist/pinbox`;
const SCHEMA_JSON = `${repoRoot}packages/core/dist/schema.json`;

// The shipped-artifact PATH: system tools only (git, mktemp, pwd), no JS runtime.
const RESTRICTED_PATH = "/usr/bin:/bin";

let tmp = "";
let projectDir = "";
let env: {
  PATH: string;
  HOME: string;
  XDG_STATE_HOME: string;
  PINBOX_IDLE_MS: string;
};

// Same shape as the schema fixtures (packages/core/src/schema.test.ts).
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

beforeAll(async () => {
  tmp = (await Bun.$`mktemp -d`.text()).trim();
  projectDir = `${tmp}/project`;
  env = {
    PATH: RESTRICTED_PATH,
    HOME: `${tmp}/home`,
    XDG_STATE_HOME: `${tmp}/state`,
    PINBOX_IDLE_MS: "60000",
  };
  await Bun.$`mkdir -p ${projectDir} ${env.HOME}`.quiet();
  Bun.spawnSync(["git", "init", "-q"], { cwd: projectDir, env });
});

afterAll(async () => {
  // Belt and braces: if the flow died before its own SIGTERM step, reap the daemon.
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

test("compiled binary exists and the e2e PATH carries no JS runtime", async () => {
  expect(
    await Bun.file(BINARY).exists(),
    `missing ${BINARY} — run \`bun run build\` first (ci:validate builds before testing)`,
  ).toBe(true);
  expect(Bun.which("bun", { PATH: RESTRICTED_PATH })).toBeNull();
  expect(Bun.which("node", { PATH: RESTRICTED_PATH })).toBeNull();
});

test("full loop over the shipped binary: spawn, pin, list, resolve, export, doctor, shutdown", async () => {
  // summary auto-spawns the hub and reports an empty project
  const summary = await run(["summary", "--json"]);
  expect(summary.code).toBe(0);
  const summaryEnvelope = parseEnvelope(summary.stdout) as {
    ok: boolean;
    data: { open: number; resolved: number; lastEventSeq: number };
  };
  expect(summaryEnvelope.ok).toBe(true);
  expect(summaryEnvelope.data.open).toBe(0);
  expect(summaryEnvelope.data.resolved).toBe(0);

  // .pinbox/server.json is discovery only: the port, and not one byte of secret
  const serverJson = (await Bun.file(`${projectDir}/.pinbox/server.json`).json()) as Record<
    string,
    unknown
  >;
  expect(Object.keys(serverJson)).toEqual(["port"]);
  expect(typeof serverJson["port"]).toBe("number");

  // the token lives in the XDG state dir's hub.json
  const state = await readHubState();
  if (state === null) throw new Error("hub.json not found under XDG_STATE_HOME");
  expect(state.port).toBe(serverJson["port"] as number);

  // a pin created over raw HTTP (the toolbar's path) lands in the hub
  const created = await fetch(`http://127.0.0.1:${state.port}/pins`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(validInput),
  });
  expect(created.status).toBe(201);
  const createdEnvelope = (await created.json()) as { ok: boolean; data: { id: string } };
  expect(createdEnvelope.ok).toBe(true);
  const pinId = createdEnvelope.data.id;
  expect(pinId).toMatch(/^pin_[a-z0-9]{10}$/);

  // list sees it
  const list = await run(["list", "--json"]);
  expect(list.code).toBe(0);
  const listEnvelope = parseEnvelope(list.stdout) as {
    data: { id: string; status: string }[];
  };
  expect(listEnvelope.data.map((pin) => pin.id)).toEqual([pinId]);
  expect(listEnvelope.data[0]?.status).toBe("open");

  // resolve flips it
  const resolve = await run(["resolve", pinId, "--note", "done", "--json"]);
  expect(resolve.code).toBe(0);
  const resolveEnvelope = parseEnvelope(resolve.stdout) as {
    data: { status: string; resolution?: { note?: string } };
  };
  expect(resolveEnvelope.data.status).toBe("resolved");
  expect(resolveEnvelope.data.resolution?.note).toBe("done");

  // export renders the resolved pin as markdown on stdout
  const exported = await run(["export", "--format", "md"]);
  expect(exported.code).toBe(0);
  expect(exported.stdout).toContain("[resolved]");
  expect(exported.stdout).toContain(pinId);

  // doctor: every capability probe passes on the machine the binary shipped to
  const doctor = await run(["doctor", "--json"]);
  expect(doctor.code).toBe(0);
  const doctorEnvelope = parseEnvelope(doctor.stdout) as {
    data: { checks: { name: string; ok: boolean; detail: string }[] };
  };
  for (const check of doctorEnvelope.data.checks) {
    expect(check.ok, `doctor check ${check.name} failed: ${check.detail}`).toBe(true);
  }

  // SIGTERM the daemon: it exits and removes both state files
  process.kill(state.pid, "SIGTERM");
  const gone = await waitFor(() => !isAlive(state.pid), 5_000);
  expect(gone, "hub daemon still alive 5s after SIGTERM").toBe(true);
  const cleaned = await waitFor(
    async () =>
      !(await Bun.file(`${projectDir}/.pinbox/server.json`).exists()) &&
      (await readHubState()) === null,
    5_000,
  );
  expect(cleaned, "state files not cleaned up after SIGTERM").toBe(true);
}, 60_000);

test("build emits dist/schema.json and it parses to the pin JSON Schema", async () => {
  expect(
    await Bun.file(SCHEMA_JSON).exists(),
    `missing ${SCHEMA_JSON} — the core build must emit it (broken "./schema.json" export)`,
  ).toBe(true);
  const schema = (await Bun.file(SCHEMA_JSON).json()) as Record<string, unknown>;
  expect(schema["type"]).toBe("object");
  expect(JSON.stringify(schema)).toContain("attachments");
});

/** Run the compiled binary in the temp project with the restricted environment. */
async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([BINARY, ...args], {
    cwd: projectDir,
    env,
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

function parseEnvelope(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`stdout is not a JSON envelope: ${JSON.stringify(stdout)}`);
  }
}

/** The state file the daemon writes under XDG_STATE_HOME (project id is hashed — glob). */
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
    return (await Bun.file(`${env.XDG_STATE_HOME}/${first}`).json()) as {
      pid: number;
      port: number;
      token: string;
    };
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(50);
  }
  return condition();
}
