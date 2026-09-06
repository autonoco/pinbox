// GitHub App transport: JWT minting and installation-token caching against a fake fetch,
// the op → REST mapping, error hints, and PKCS#1 → PKCS#8 wrapping of GitHub's key download.
// The RSA pair is generated per file with node:crypto (Bun implements it); the JWT is
// verified with jose against the public half — the test never trusts its own encoder.

import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import {
  createGithubAppTransport,
  type FetchLike,
  GithubAppError,
  toPkcs8Pem,
} from "./github-app.ts";

let pkcs1Pem = "";
let pkcs8Pem = "";
let publicPem = "";

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  pkcs1Pem = pair.privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  pkcs8Pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  publicPem = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
});

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A GitHub that answers by path; records every call. */
function fakeGithub(
  respond: (method: string, path: string, body: unknown) => { status: number; body: unknown },
) {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    seen.push({ method, url, headers, body });
    const { status, body: out } = respond(method, new URL(url).pathname, body);
    return new Response(JSON.stringify(out), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, fetchImpl };
}

const T0 = Date.parse("2026-09-05T12:00:00.000Z");
const tokenResponse = (suffix: string, expiresInMs = 3_600_000) => ({
  status: 201,
  body: { token: `ghs_${suffix}`, expires_at: new Date(T0 + expiresInMs).toISOString() },
});

function transportWith(
  gh: ReturnType<typeof fakeGithub>,
  extra: Partial<Parameters<typeof createGithubAppTransport>[0]> = {},
  clock: { now: number } = { now: T0 },
) {
  return createGithubAppTransport({
    appId: "12345",
    privateKeyPem: pkcs1Pem,
    installationId: "777",
    repo: "autonoco/pinbox",
    fetchImpl: gh.fetchImpl,
    now: () => clock.now,
    ...extra,
  });
}

describe("app JWT and installation token", () => {
  test("mints an RS256 App JWT (iss = app id, ≤10 min) and exchanges it for an installation token", async () => {
    const gh = fakeGithub((method, path) => {
      if (method === "POST" && path === "/app/installations/777/access_tokens")
        return tokenResponse("one");
      if (method === "POST" && path === "/repos/autonoco/pinbox/issues")
        return {
          status: 201,
          body: {
            number: 58,
            html_url: "https://github.com/autonoco/pinbox/issues/58",
            state: "open",
          },
        };
      return { status: 404, body: {} };
    });
    const t = transportWith(gh);
    const created = await t.request("issue.create", { title: "t", body: "b" });
    expect(created).toEqual({ number: 58, url: "https://github.com/autonoco/pinbox/issues/58" });

    const mint = gh.seen[0] as Seen;
    const jwt = mint.headers["authorization"]?.replace("Bearer ", "") ?? "";
    const { payload, protectedHeader } = await jwtVerify(
      jwt,
      await importSPKI(publicPem, "RS256"),
      { issuer: "12345", currentDate: new Date(T0) },
    );
    expect(protectedHeader.alg).toBe("RS256");
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(600);
    expect(payload.iat).toBe(Math.floor(T0 / 1000) - 60);
    expect(mint.headers["accept"]).toBe("application/vnd.github+json");
    expect(mint.headers["x-github-api-version"]).toBe("2022-11-28");

    const create = gh.seen[1] as Seen;
    expect(create.headers["authorization"]).toBe("Bearer ghs_one");
    expect(create.body).toEqual({ title: "t", body: "b" });
  });

  test("caches the installation token until a minute before expiry, then re-mints", async () => {
    let mints = 0;
    const gh = fakeGithub((method, path) => {
      if (path === "/app/installations/777/access_tokens") {
        mints += 1;
        return tokenResponse(String(mints), 3_600_000);
      }
      if (method === "PATCH") return { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    const clock = { now: T0 };
    const t = transportWith(gh, {}, clock);
    await t.request("issue.close", { number: 1 });
    await t.request("issue.reopen", { number: 1 });
    expect(mints).toBe(1);
    clock.now = T0 + 3_600_000 - 30_000; // inside the refresh margin
    await t.request("issue.close", { number: 1 });
    expect(mints).toBe(2);
    expect((gh.seen.at(-1) as Seen).headers["authorization"]).toBe("Bearer ghs_2");
  });

  test("a PKCS#8 key works as-is; a non-PEM value is refused with a hint", async () => {
    const gh = fakeGithub((_m, path) =>
      path.endsWith("/access_tokens") ? tokenResponse("x") : { status: 200, body: {} },
    );
    const t = transportWith(gh, { privateKeyPem: pkcs8Pem });
    await t.request("issue.close", { number: 2 });
    expect(gh.seen.length).toBe(2);
    expect(() => toPkcs8Pem("not a key")).toThrow(GithubAppError);
    expect(toPkcs8Pem(pkcs1Pem)).toStartWith("-----BEGIN PRIVATE KEY-----");
    expect(toPkcs8Pem(pkcs8Pem)).toBe(pkcs8Pem.trim());
  });
});

describe("op mapping", () => {
  test("issue.view joins the issue state with every comment page, mapping authors and timestamps", async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        user: i === 0 && n === 1 ? null : { login: `u${n}-${i}` },
        body: i === 1 ? null : `c${n}-${i}`,
        created_at: `2026-09-0${n}T00:00:0${i % 10}.000Z`,
      }));
    // Two pages: a full first page, then a short one.
    let call = 0;
    const paged = fakeGithub((method, path) => {
      if (path.endsWith("/access_tokens")) return tokenResponse("v");
      if (method === "GET" && path === "/repos/autonoco/pinbox/issues/9")
        return { status: 200, body: { number: 9, html_url: "", state: "closed" } };
      if (method === "GET" && path === "/repos/autonoco/pinbox/issues/9/comments") {
        call += 1;
        return { status: 200, body: call === 1 ? page(1, 100) : page(2, 3) };
      }
      return { status: 404, body: {} };
    });
    const view = (await transportWith(paged).request("issue.view", { number: 9 })) as {
      state: string;
      comments: { author: string; body: string; createdAt: string }[];
    };
    expect(view.state).toBe("closed");
    expect(view.comments).toHaveLength(103);
    expect(view.comments[0]).toEqual({
      author: "ghost",
      body: "c1-0",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(view.comments[1]?.body).toBe(""); // a null body mirrors as empty, never "null"
    expect(view.comments[102]?.author).toBe("u2-2");
    const commentCalls = paged.seen.filter((s) => s.url.includes("/comments"));
    expect(commentCalls.map((s) => new URL(s.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test("issue.comment posts the body; unknown ops throw", async () => {
    const gh = fakeGithub((method, path) => {
      if (path.endsWith("/access_tokens")) return tokenResponse("c");
      if (method === "POST" && path === "/repos/autonoco/pinbox/issues/4/comments")
        return { status: 201, body: {} };
      return { status: 404, body: {} };
    });
    const t = transportWith(gh);
    await t.request("issue.comment", { number: 4, body: "hello" });
    expect((gh.seen.at(-1) as Seen).body).toEqual({ body: "hello" });
    await expect(t.request("issue.explode", {})).rejects.toThrow("unknown github op");
  });
});

describe("errors carry hints", () => {
  test("a 404 on the repo points at the installation; a 401 on minting at the key pair", async () => {
    const gh = fakeGithub((_m, path) =>
      path.endsWith("/access_tokens")
        ? tokenResponse("e")
        : { status: 404, body: { message: "Not Found" } },
    );
    const err = (await transportWith(gh)
      .request("issue.close", { number: 1 })
      .catch((e: unknown) => e)) as GithubAppError;
    expect(err).toBeInstanceOf(GithubAppError);
    expect(err.status).toBe(404);
    expect(err.hint).toContain("installed on autonoco/pinbox");

    const bad = fakeGithub(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const mintErr = (await transportWith(bad)
      .request("issue.close", { number: 1 })
      .catch((e: unknown) => e)) as GithubAppError;
    expect(mintErr.hint).toContain("GITHUB_APP_ID");
    expect(() => transportWith(gh, { repo: "nope" })).toThrow('must be "owner/name"');
  });
});
