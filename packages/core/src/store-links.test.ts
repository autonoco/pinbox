// Covers the links table (migration 4), the addLink/links store methods, and the
// additive opts param on addThreadMessage. Both PinStore implementations replay the
// same migration list, so a change here must land in do-store.ts too.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Link } from "./schema.ts";
import { ConflictError, NotFoundError, openStore } from "./store.ts";

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
} as const;

const githubLink: Link = {
  connector: "github",
  ref: "123",
  url: "https://github.com/acme/app/issues/123",
};

// Byte-copy of the baseline DDL as it shipped BEFORE the migration scaffolding
// landed — simulates a pre-freeze db sitting at user_version 0.
const PRE_FREEZE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pins (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  due_at TEXT,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY,
  pin_id TEXT NOT NULL,
  at TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pins_due_at ON pins(due_at) WHERE due_at IS NOT NULL;
`;

const tmpDirs: string[] = [];

async function tmpDbPath(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  tmpDirs.push(dir);
  return `${dir}/pinbox.db`;
}

function userVersion(path: string): number {
  const db = new Database(path);
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  db.close();
  return row.user_version;
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await Bun.$`rm -rf ${dir}`;
  }
});

describe("migrations", () => {
  test("a fresh store opens at user_version 4", async () => {
    const path = await tmpDbPath();
    const store = openStore(path);
    store.close();
    expect(userVersion(path)).toBe(4);
  });

  test("a pre-freeze db at user_version 0 migrates cleanly through openStore", async () => {
    const path = await tmpDbPath();
    const raw = new Database(path);
    raw.exec(PRE_FREEZE_DDL);
    raw.close();
    expect(userVersion(path)).toBe(0);

    const store = openStore(path);
    const pin = store.createPin(validInput, {});
    const updated = store.addLink(pin.id, githubLink);
    expect(updated.links).toEqual([githubLink]);
    store.close();
    expect(userVersion(path)).toBe(4);
  });
});

describe("addLink", () => {
  test("round-trips through getPin, links.forPin, and the event log", () => {
    const store = openStore(":memory:");
    const pin = store.createPin(validInput, {});

    const updated = store.addLink(pin.id, githubLink);
    expect(updated.links).toEqual([githubLink]);
    expect(store.getPin(pin.id)?.links).toEqual([githubLink]);
    expect(store.links.forPin(pin.id)).toEqual([githubLink]);

    const events = store.eventsAfter(0);
    const last = events.at(-1);
    expect(last?.type).toBe("pin.linked");
    // payload is the full post-mutation Pin (§3)
    const payload = last?.payload as { id: string; links: Link[] };
    expect(payload.id).toBe(pin.id);
    expect(payload.links).toEqual([githubLink]);
    store.close();
  });

  test("duplicate (connector, ref) for the pin throws ConflictError", () => {
    const store = openStore(":memory:");
    const pin = store.createPin(validInput, {});
    store.addLink(pin.id, githubLink);
    expect(() => store.addLink(pin.id, githubLink)).toThrow(ConflictError);
    // a different ref on the same connector is fine
    store.addLink(pin.id, { ...githubLink, ref: "124" });
    store.close();
  });

  test("unknown pin throws NotFoundError", () => {
    const store = openStore(":memory:");
    expect(() => store.addLink("pin_0000000000", githubLink)).toThrow(NotFoundError);
    store.close();
  });
});

describe("links store", () => {
  test("all() reports lastSyncedAt null until markSynced", () => {
    const store = openStore(":memory:");
    const pin = store.createPin(validInput, {});
    store.addLink(pin.id, githubLink);

    const before = store.links.all();
    expect(before).toEqual([{ pinId: pin.id, link: githubLink, lastSyncedAt: null }]);

    const at = "2026-08-04T12:00:00.000Z";
    store.links.markSynced(pin.id, { connector: "github", ref: "123" }, at);
    const after = store.links.all();
    expect(after[0]?.lastSyncedAt).toBe(at);
    store.close();
  });
});

describe("addThreadMessage opts", () => {
  test("origin persists and round-trips through getThread", () => {
    const store = openStore(":memory:");
    const pin = store.createPin(validInput, {});
    const message = store.addThreadMessage(pin.id, "mirror", "hi", { origin: "github:benji" });
    expect(message.origin).toBe("github:benji");
    const thread = store.getThread(pin.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]?.origin).toBe("github:benji");
    expect(thread[0]?.role).toBe("mirror");
    store.close();
  });

  test("omitted opts leaves origin undefined", () => {
    const store = openStore(":memory:");
    const pin = store.createPin(validInput, {});
    store.addThreadMessage(pin.id, "human", "plain");
    expect(store.getThread(pin.id)[0]?.origin).toBeUndefined();
    store.close();
  });
});
