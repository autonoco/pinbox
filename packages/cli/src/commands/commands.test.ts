// Integration tests for the core verbs, against an IN-PROCESS hub:
// startHubServer + openStore(":memory:"), injected via setConnectionForTests — no
// daemon spawn. Error envelopes and exit codes are pinned to the UX spec transcripts
// (docs/design/cli/v1-transcripts.md). Human renderings live in rendering.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { startHubServer } from "@autono/pinbox-core/hub-server";
import type { Pin, ThreadMessage } from "@autono/pinbox-core/schema";
import { openStore, type PinStore } from "@autono/pinbox-core/store";
import { HubClient } from "../client.ts";
import { setConnectionForTests } from "../daemon.ts";
import { runExport } from "./export.ts";
import { runList } from "./list.ts";
import { runReply } from "./reply.ts";
import { runResolve } from "./resolve.ts";
import { runShow } from "./show.ts";
import { runSummary } from "./summary.ts";
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

let store: PinStore;
let server: Awaited<ReturnType<typeof startHubServer>>;
let hub: HubClient;

beforeAll(async () => {
  store = openStore(":memory:");
  server = await startHubServer({ store, token: "t-test", idleMs: 60_000 });
  setConnectionForTests({ baseUrl: `http://127.0.0.1:${server.port}`, token: "t-test" });
  hub = new HubClient(`http://127.0.0.1:${server.port}`, "t-test");
});

afterAll(async () => {
  setConnectionForTests(null);
  await server.close();
  store.close();
});

afterEach(() => {
  setTTY(originalIsTTY);
});

describe("command loop against an in-process hub", () => {
  let pinId = "";

  test("createPin via HubClient returns a full open pin", async () => {
    const pin = await hub.createPin(validInput);
    pinId = pin.id;
    expect(pin.id).toMatch(/^pin_[a-z0-9]{10}$/);
    expect(pin.status).toBe("open");
  });

  test("list --json emits the envelope with the full pin", async () => {
    const body = (await capture(() => runList({ json: true }))) as { ok: boolean; data: Pin[] };
    expect(body.ok).toBe(true);
    expect(body.data.map((p) => p.id)).toEqual([pinId]);
    expect(body.data[0]?.text).toBe("button is cut off");
  });

  test("show --json joins the pin with its (empty) thread", async () => {
    const body = (await capture(() => runShow(pinId, { json: true }))) as {
      ok: boolean;
      data: { pin: Pin; thread: ThreadMessage[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.pin.id).toBe(pinId);
    expect(body.data.thread).toEqual([]);
  });

  test("reply --json emits the created ThreadMessage; show then includes it", async () => {
    const body = (await capture(() =>
      runReply(pinId, "does this also happen at 1024px?", { as: "human", json: true }),
    )) as { ok: boolean; data: ThreadMessage };
    expect(body.ok).toBe(true);
    expect(body.data.id).toMatch(/^msg_[a-z0-9]{10}$/);
    expect(body.data.pinId).toBe(pinId);
    expect(body.data.role).toBe("human");
    expect(body.data.text).toBe("does this also happen at 1024px?");

    const shown = (await capture(() => runShow(pinId, { json: true }))) as {
      data: { thread: ThreadMessage[] };
    };
    expect(shown.data.thread.map((m) => m.text)).toEqual(["does this also happen at 1024px?"]);
  });

  test("reply human mode: message id on stdout, confirmation on stderr", async () => {
    setTTY(true);
    const spies = installSpies();
    try {
      await runReply(pinId, "Yes — same overflow at 1024. One fix covers both.", {
        as: "agent",
        json: false,
      });
      expect(String(spies.out.mock.calls[0]?.[0])).toMatch(/^msg_[a-z0-9]{10}$/);
      expect(spies.err.mock.calls.map((c) => c[0])).toEqual([`replied to ${pinId} as agent`]);
    } finally {
      restoreSpies(spies);
    }
  });

  test("resolve --json flips status and carries the resolution", async () => {
    const body = (await capture(() =>
      runResolve(pinId, {
        as: "agent",
        note: "flex-shrink on the CTA; verified at 1024 and 1280",
        json: true,
      }),
    )) as { ok: boolean; data: Pin };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("resolved");
    expect(body.data.resolution?.by).toBe("agent");
    expect(body.data.resolution?.note).toBe("flex-shrink on the CTA; verified at 1024 and 1280");
  });

  test("second resolve is E_CONFLICT with the transcript message, exit 4", async () => {
    const spies = installSpies();
    try {
      await expect(runResolve(pinId, { as: "human", json: true })).rejects.toThrow(ExitSignal);
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_CONFLICT",
          message: `${pinId} is already resolved`,
          hint: `run \`pinbox show ${pinId}\` to see who resolved it and why`,
        },
      });
      expect(spies.exit).toHaveBeenCalledWith(4);
    } finally {
      restoreSpies(spies);
    }
  });

  test("export --format md --detail compact writes raw markdown to stdout", async () => {
    const spies = installSpies();
    try {
      await runExport({ format: "md", detail: "compact", status: "resolved" });
      expect(spies.out.mock.calls.map((c) => String(c[0]).split("\n")[0])).toEqual([
        `- [resolved] main > button.cta — button is cut off (${pinId})`,
      ]);
      expect(spies.err).not.toHaveBeenCalled();
    } finally {
      restoreSpies(spies);
    }
  });

  test("export --format json emits the same envelope-and-Pin[] shape as list", async () => {
    const body = (await capture(() =>
      runExport({ format: "json", detail: "standard", status: "resolved" }),
    )) as { ok: boolean; data: Pin[] };
    expect(body.ok).toBe(true);
    expect(body.data.map((p) => p.id)).toEqual([pinId]);
  });

  test("summary --json counts and the event cursor", async () => {
    const doc = await capture(() => runSummary({ json: true }));
    expect(doc).toEqual({
      ok: true,
      data: { open: 0, resolved: 1, lastEventSeq: expect.any(Number), sessions: 0 },
    });
  });

  test("resolve human mode: fact on stdout, by-line on stderr", async () => {
    setTTY(true);
    const spies = installSpies();
    const extra = await hub.createPin(validInput);
    try {
      await runResolve(extra.id, {
        as: "human",
        note: "intended: logo ships as 1x until the brand refresh",
        json: false,
      });
      expect(spies.out.mock.calls.map((c) => c[0])).toEqual([`${extra.id} resolved`]);
      expect(spies.err.mock.calls.map((c) => c[0])).toEqual([
        "by human — intended: logo ships as 1x until the brand refresh",
      ]);
    } finally {
      restoreSpies(spies);
    }
  });

  test("unknown id is E_NOT_FOUND with the transcript message, exit 3", async () => {
    const spies = installSpies();
    try {
      await expect(runShow("pin_0000000000", { json: true })).rejects.toThrow(ExitSignal);
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
});

describe("flag validation", () => {
  test("list --status closed is E_INVALID_INPUT", async () => {
    const spies = installSpies();
    try {
      await expect(runList({ status: "closed", json: true })).rejects.toThrow(ExitSignal);
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_INVALID_INPUT",
          message: 'invalid --status: "closed" (expected open or resolved)',
          hint: "run `pinbox list --help` for usage",
        },
      });
      expect(spies.exit).toHaveBeenCalledWith(2);
    } finally {
      restoreSpies(spies);
    }
  });

  test("reply with empty text is E_INVALID_INPUT with the quoting hint", async () => {
    const spies = installSpies();
    try {
      await expect(runReply("pin_ab12cd34ef", "", { as: "human", json: true })).rejects.toThrow(
        ExitSignal,
      );
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_INVALID_INPUT",
          message: "reply text must not be empty",
          hint: 'quote the message: pinbox reply <id> "your text"',
        },
      });
      expect(spies.exit).toHaveBeenCalledWith(2);
    } finally {
      restoreSpies(spies);
    }
  });

  test("export --detail full in md mode reports the human error on stderr even when piped", async () => {
    setTTY(undefined); // piped stdout — md mode must still error human-style
    const spies = installSpies();
    try {
      await expect(runExport({ format: "md", detail: "full" })).rejects.toThrow(ExitSignal);
      expect(spies.out).not.toHaveBeenCalled();
      expect(spies.err.mock.calls.map((c) => c[0])).toEqual([
        'pinbox: invalid --detail: "full" (expected compact, standard, or forensic)',
        "run `pinbox export --help` for usage",
      ]);
      expect(spies.exit).toHaveBeenCalledWith(2);
    } finally {
      restoreSpies(spies);
    }
  });

  test("export --detail full --format json emits the JSON error envelope", async () => {
    const spies = installSpies();
    try {
      await expect(runExport({ format: "json", detail: "full" })).rejects.toThrow(ExitSignal);
      expect(JSON.parse(String(spies.out.mock.calls[0]?.[0]))).toEqual({
        ok: false,
        error: {
          code: "E_INVALID_INPUT",
          message: 'invalid --detail: "full" (expected compact, standard, or forensic)',
          hint: "run `pinbox export --help` for usage",
        },
      });
    } finally {
      restoreSpies(spies);
    }
  });
});
