// pinbox CLI — link command tests, against an IN-PROCESS hub constructed with a
// FakeConnector in HubOptions.connectors (the commands.test.ts pattern; connection
// injected via setConnectionForTests — no daemon spawn, no gh). Envelopes and exit
// codes follow the v1-transcripts style.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Connector } from "@autono/pinbox-core/connectors";
import { startHubServer } from "@autono/pinbox-core/hub-server";
import type { Pin } from "@autono/pinbox-core/schema";
import { openStore, type PinStore } from "@autono/pinbox-core/store";
import { $ } from "bun";
import { HubClient } from "../client.ts";
import { setConnectionForTests } from "../daemon.ts";
import { runLink } from "./link.ts";
import { validInput } from "./transcript-fixtures.ts";

/** Sentinel thrown by the process.exit spy so `fail` actually stops. */
class ExitSignal extends Error {
  constructor(public exitCode: number | undefined) {
    super(`exit ${exitCode}`);
  }
}

function setTTY(isTTY: boolean | undefined): void {
  Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
}
const originalIsTTY = process.stdout.isTTY;

type Spies = {
  out: ReturnType<typeof spyOn<Console, "log">>;
  err: ReturnType<typeof spyOn<Console, "error">>;
  exit: ReturnType<typeof spyOn<typeof process, "exit">>;
};

function installSpies(): Spies {
  return {
    out: spyOn(console, "log").mockImplementation(() => {}),
    err: spyOn(console, "error").mockImplementation(() => {}),
    exit: spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitSignal(code);
    }) as typeof process.exit),
  };
}

function restoreSpies(spies: Spies): void {
  spies.out.mockRestore();
  spies.err.mockRestore();
  spies.exit.mockRestore();
  process.exitCode = 0;
}

/** Run a command function and return the single JSON document it printed to stdout. */
async function capture(run: () => Promise<void>): Promise<unknown> {
  const spies = installSpies();
  try {
    await run();
    return JSON.parse(String(spies.out.mock.calls.at(-1)?.[0]));
  } finally {
    restoreSpies(spies);
  }
}

let failCreate: Error | null = null;
const fakeConnector: Connector = {
  name: "github",
  async createItem() {
    if (failCreate !== null) throw failCreate;
    return { connector: "github", ref: "123", url: "https://github.com/acme/app/issues/123" };
  },
  async postComment() {},
  async sync() {},
  async setRemoteStatus() {},
};

let store: PinStore;
let server: Awaited<ReturnType<typeof startHubServer>>;
let hub: HubClient;

beforeAll(async () => {
  store = openStore(":memory:");
  server = await startHubServer({
    store,
    token: "t-test",
    connectors: [fakeConnector],
    idleMs: 60_000,
  });
  setConnectionForTests({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t-test" });
  hub = new HubClient(`http://127.0.0.1:${server.port}`, "t-test");
});

afterAll(async () => {
  setConnectionForTests(null);
  await server.close();
  store.close();
});

afterEach(() => {
  failCreate = null;
  setTTY(originalIsTTY);
});

describe("pinbox link against an in-process hub", () => {
  let pinId = "";

  test("happy path --json emits the updated full Pin with the link appended", async () => {
    const pin = await hub.createPin(validInput);
    pinId = pin.id;
    const body = (await capture(() => runLink(pinId, "github", { json: true }))) as {
      ok: boolean;
      data: Pin;
    };
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(pinId);
    expect(body.data.links).toEqual([
      { connector: "github", ref: "123", url: "https://github.com/acme/app/issues/123" },
    ]);
  });

  test("human mode: facts on stdout, confirmation on stderr", async () => {
    setTTY(true);
    const extra = await hub.createPin(validInput);
    const spies = installSpies();
    try {
      await runLink(extra.id, "github", { json: false });
      expect(spies.out.mock.calls.map((c) => c[0])).toEqual([
        "github#123  https://github.com/acme/app/issues/123",
      ]);
      expect(spies.err.mock.calls.map((c) => c[0])).toEqual([`linked ${extra.id} to github#123`]);
    } finally {
      restoreSpies(spies);
    }
  });

  test("second identical link is E_CONFLICT, exit 4", async () => {
    const spies = installSpies();
    try {
      await expect(runLink(pinId, "github", { json: true })).rejects.toThrow(ExitSignal);
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_CONFLICT",
          message: `pin already linked: ${pinId} → github#123`,
          hint: `run \`pinbox show ${pinId}\` to see its links`,
        },
      });
      expect(spies.exit).toHaveBeenCalledWith(4);
    } finally {
      restoreSpies(spies);
    }
  });

  test("unknown connector is E_CONNECTOR with the hub's doctor hint, exit 10", async () => {
    const spies = installSpies();
    try {
      await expect(runLink(pinId, "nope", { json: true })).rejects.toThrow(ExitSignal);
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_CONNECTOR",
          message: "no connector available: nope",
          hint: "run `pinbox doctor` to see which connectors this hub can reach",
        },
      });
      expect(spies.exit).toHaveBeenCalledWith(10);
    } finally {
      restoreSpies(spies);
    }
  });

  test("connector createItem throwing surfaces as E_CONNECTOR, exit 10", async () => {
    failCreate = new Error("gh: HTTP 502 from api.github.com");
    const extra = await hub.createPin(validInput);
    const spies = installSpies();
    try {
      await expect(runLink(extra.id, "github", { json: true })).rejects.toThrow(ExitSignal);
      const doc = JSON.parse(String(spies.out.mock.calls[0]?.[0])) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(doc.error.code).toBe("E_CONNECTOR");
      expect(doc.error.message).toBe("gh: HTTP 502 from api.github.com");
      expect(spies.exit).toHaveBeenCalledWith(10);
    } finally {
      restoreSpies(spies);
    }
  });

  test("unknown pin is E_NOT_FOUND with the transcript message, exit 3", async () => {
    const spies = installSpies();
    try {
      await expect(runLink("pin_0000000000", "github", { json: true })).rejects.toThrow(ExitSignal);
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_NOT_FOUND",
          message: "no pin with id pin_0000000000",
          hint: "run `pinbox list` to see valid ids (full ids only — prefixes don't match)",
        },
      });
      expect(spies.exit).toHaveBeenCalledWith(3);
    } finally {
      restoreSpies(spies);
    }
  });

  test("connectorless hub + no gh on PATH hints the gh install", async () => {
    // A hub whose serve boot found no gh (localConnectors → []) answers 502; the CLI
    // sees WHY (Bun.which) and swaps in the install hint from the plan.
    const bareStore = openStore(":memory:");
    const bare = await startHubServer({ store: bareStore, token: "t-bare", idleMs: 60_000 });
    const bareHub = new HubClient(`http://127.0.0.1:${bare.port}`, "t-bare");
    const originalPath = process.env["PATH"] ?? "";
    const empty = (await $`mktemp -d`.text()).trim();
    setConnectionForTests({ baseUrl: `http://127.0.0.1:${bare.port}`, token: "t-bare" });
    const pin = await bareHub.createPin(validInput);
    process.env["PATH"] = empty;
    const spies = installSpies();
    try {
      await expect(runLink(pin.id, "github", { json: true })).rejects.toThrow(ExitSignal);
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_CONNECTOR",
          message: "no connector available: github",
          hint: "install GitHub CLI (gh) and run `gh auth login`",
        },
      });
      expect(spies.exit).toHaveBeenCalledWith(10);
    } finally {
      restoreSpies(spies);
      process.env["PATH"] = originalPath;
      setConnectionForTests({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t-test" });
      await bare.close();
      bareStore.close();
      await $`rm -rf ${empty}`.quiet();
    }
  });
});
