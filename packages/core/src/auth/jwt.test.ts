import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createHubHandler } from "../hub.ts";
import { openStore } from "../store.ts";
import { verifyJwt } from "./verify.ts";

const ISSUER = "https://issuer.test";
const AUDIENCE = "tool:pinbox";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let ed: KeyPair;
let rsa: KeyPair;
let server: ReturnType<typeof Bun.serve>;
let jwksUrl: string;

beforeAll(async () => {
  ed = await generateKeyPair("EdDSA", { extractable: true });
  rsa = await generateKeyPair("RS256", { extractable: true });
  const keys = [
    { ...(await exportJWK(ed.publicKey)), alg: "EdDSA", kid: "ed1" },
    { ...(await exportJWK(rsa.publicKey)), alg: "RS256", kid: "rsa1" },
  ];
  server = Bun.serve({ port: 0, fetch: () => Response.json({ keys }) });
  jwksUrl = `http://localhost:${server.port}/jwks.json`;
});

afterAll(() => {
  server.stop(true);
});

type SignOverrides = {
  issuer?: string;
  audience?: string;
  sub?: string;
  expiresAt?: number;
  claims?: Record<string, unknown>;
};

async function sign(
  key: CryptoKey,
  alg: "EdDSA" | "RS256",
  kid: string,
  overrides: SignOverrides = {},
): Promise<string> {
  const jwt = new SignJWT(overrides.claims ?? {})
    .setProtectedHeader({ alg, kid })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.sub ?? "user_1")
    .setIssuedAt(overrides.expiresAt === undefined ? undefined : overrides.expiresAt - 300)
    .setExpirationTime(overrides.expiresAt ?? "5m");
  return jwt.sign(key);
}

function makeVerify() {
  return verifyJwt({ issuer: ISSUER, jwksUrl, audience: AUDIENCE });
}

function req(authorization?: string): Request {
  return new Request(
    "http://hub/summary",
    authorization === undefined ? {} : { headers: { authorization } },
  );
}

describe("verifyJwt", () => {
  test("verifies a valid EdDSA token to { userId, tenantId }", async () => {
    const token = await sign(ed.privateKey, "EdDSA", "ed1", {
      claims: { tenant: "acme" },
    });
    const identity = await makeVerify()(req(`Bearer ${token}`));
    expect(identity).toEqual({ userId: "user_1", tenantId: "acme" });
  });

  test("verifies a valid RS256 token", async () => {
    const token = await sign(rsa.privateKey, "RS256", "rsa1");
    const identity = await makeVerify()(req(`Bearer ${token}`));
    expect(identity).toEqual({ userId: "user_1" });
  });

  test("carries optional name/email claims when present", async () => {
    const token = await sign(ed.privateKey, "EdDSA", "ed1", {
      claims: { name: "Bobak", email: "bobak@autono.co" },
    });
    const identity = await makeVerify()(req(`Bearer ${token}`));
    expect(identity).toEqual({
      userId: "user_1",
      name: "Bobak",
      email: "bobak@autono.co",
    });
  });

  test("rejects a wrong audience", async () => {
    const token = await sign(ed.privateKey, "EdDSA", "ed1", { audience: "tool:other" });
    expect(await makeVerify()(req(`Bearer ${token}`))).toBeNull();
  });

  test("rejects a wrong issuer", async () => {
    const token = await sign(ed.privateKey, "EdDSA", "ed1", {
      issuer: "https://evil.test",
    });
    expect(await makeVerify()(req(`Bearer ${token}`))).toBeNull();
  });

  test("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const token = await sign(ed.privateKey, "EdDSA", "ed1", { expiresAt: past });
    expect(await makeVerify()(req(`Bearer ${token}`))).toBeNull();
  });

  test("rejects an HS256 token (alg allowlist)", async () => {
    const secret = new TextEncoder().encode("shared-secret-of-32-bytes-min!!!");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("user_1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
    expect(await makeVerify()(req(`Bearer ${token}`))).toBeNull();
  });

  test("returns null (never throws) on a malformed token", async () => {
    expect(await makeVerify()(req("Bearer not.a.jwt"))).toBeNull();
  });

  test("returns null on a missing Authorization header", async () => {
    expect(await makeVerify()(req())).toBeNull();
  });

  test("returns null on a non-Bearer Authorization header", async () => {
    expect(await makeVerify()(req("Basic dXNlcjpwYXNz"))).toBeNull();
  });
});

describe("verifyJwt through the hub handler", () => {
  test("signed request ⇒ 200; garbage token ⇒ 401 E_AUTH", async () => {
    const handler = createHubHandler({
      store: openStore(":memory:"),
      token: "unused",
      verify: makeVerify(),
    });

    const token = await sign(ed.privateKey, "EdDSA", "ed1");
    const okRes = await handler(req(`Bearer ${token}`));
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { ok: boolean };
    expect(okBody.ok).toBe(true);

    const badRes = await handler(req("Bearer garbage"));
    expect(badRes.status).toBe(401);
    const badBody = (await badRes.json()) as { ok: boolean; error: { code: string } };
    expect(badBody.ok).toBe(false);
    expect(badBody.error.code).toBe("E_AUTH");
  });
});
