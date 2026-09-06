// `pinbox github setup` end to end over fake seams: a GitHub that converts the manifest,
// lists the installation after one empty poll, mints a token and answers the repo read; a
// worker that records var and secret writes. No browser, no wrangler, no network.

import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { CliError } from "../errors.ts";
import { runGithubSetup, type SetupSeams } from "./flow.ts";

let pem = "";
beforeAll(() => {
  pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  }) as string;
});

type Call = { method: string; path: string; auth: string | undefined };

function fakeGithub(
  opts: {
    installAfterPolls?: number;
    repoStatus?: number;
    ownerType?: string;
    ownerStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  let polls = 0;
  const fetchImpl: SetupSeams["fetchImpl"] = async (input, init) => {
    const url = new URL(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      auth: headers["authorization"],
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/users/autonoco") {
      return json(opts.ownerStatus ?? 200, {
        login: "autonoco",
        type: opts.ownerType ?? "Organization",
      });
    }
    if (url.pathname === "/app-manifests/CODE123/conversions") {
      return json(201, {
        id: 4242,
        slug: "pinbox-pinbox",
        pem,
        webhook_secret: "whsec",
        html_url: "https://github.com/apps/pinbox-pinbox",
      });
    }
    if (url.pathname === "/app/installations") {
      polls += 1;
      const ready = polls > (opts.installAfterPolls ?? 1);
      return json(200, ready ? [{ id: 777, account: { login: "autonoco" } }] : []);
    }
    if (url.pathname === "/app/installations/777/access_tokens") {
      return json(201, {
        token: "ghs_tok",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.pathname === "/repos/autonoco/pinbox")
      return json(opts.repoStatus ?? 200, { full_name: "autonoco/pinbox" });
    return json(404, {});
  };
  return { calls, fetchImpl };
}

function seamsWith(gh: ReturnType<typeof fakeGithub>, worker: boolean) {
  const opened: string[] = [];
  const said: string[] = [];
  const vars: Record<string, string>[] = [];
  const secrets: Record<string, string> = {};
  let formHtml = "";
  const seams: SetupSeams = {
    fetchImpl: gh.fetchImpl,
    open: async (url) => void opened.push(url),
    receive: async (html, state) => {
      formHtml = html("http://127.0.0.1:5555");
      expect(formHtml).toContain(`state=${state}`);
      return "CODE123";
    },
    say: (line) => void said.push(line),
    worker: worker
      ? {
          dir: "/repo/hub",
          writeVars: async (v) => {
            vars.push(v);
            return ["GITHUB_INSTALLATION_ID"];
          },
          putSecret: async (name, value) => {
            secrets[name] = value;
          },
        }
      : null,
    pollMs: 1,
  };
  return { seams, opened, said, vars, secrets, form: () => formHtml };
}

const INPUT = {
  hubUrl: "https://app.example/_pinbox",
  repo: "autonoco/pinbox",
  appName: "pinbox-pinbox",
  printSecrets: false,
};

describe("runGithubSetup", () => {
  test("create → install → discover → write vars + secrets → verify", async () => {
    const gh = fakeGithub();
    const s = seamsWith(gh, true);
    const result = await runGithubSetup(INPUT, s.seams);
    expect(result).toMatchObject({
      appId: "4242",
      slug: "pinbox-pinbox",
      installationId: "777",
      repo: "autonoco/pinbox",
      webhookUrl: "https://app.example/_pinbox/webhooks/github",
      workerDir: "/repo/hub",
      vars: { written: true, missing: ["GITHUB_INSTALLATION_ID"] },
      secrets: "written",
      verified: true,
    });
    expect(result.secretValues).toBeUndefined(); // written secrets are never echoed
    // The manifest form targeted the org and carried the webhook URL.
    expect(s.form()).toContain("organizations/autonoco/settings/apps/new");
    expect(s.form()).toContain("webhooks/github");
    // Install page opened; installations polled with the App JWT until found; token minted.
    expect(s.opened).toEqual(["https://github.com/apps/pinbox-pinbox/installations/new"]);
    const installPolls = gh.calls.filter((c) => c.path === "/app/installations");
    expect(installPolls.length).toBe(2);
    expect(installPolls[0]?.auth).toStartWith("Bearer ey"); // a JWT, not a token
    expect(gh.calls.at(-1)).toMatchObject({
      path: "/repos/autonoco/pinbox",
      auth: "Bearer ghs_tok",
    });
    expect(s.vars).toEqual([
      { GITHUB_APP_ID: "4242", GITHUB_INSTALLATION_ID: "777", GITHUB_REPO: "autonoco/pinbox" },
    ]);
    expect(s.secrets).toEqual({ GITHUB_APP_PRIVATE_KEY: pem, GITHUB_WEBHOOK_SECRET: "whsec" });
  });

  test("the owner's profile decides the creation page: a User posts to the personal page", async () => {
    const gh = fakeGithub({ ownerType: "User" });
    const s = seamsWith(gh, true);
    await runGithubSetup(INPUT, s.seams);
    expect(s.form()).toContain('action="https://github.com/settings/apps/new?state=');
    expect(s.form()).not.toContain("organizations/");
  });

  test("when the owner lookup fails the organization page is assumed, and said", async () => {
    const gh = fakeGithub({ ownerStatus: 503 });
    const s = seamsWith(gh, true);
    await runGithubSetup(INPUT, s.seams);
    expect(s.form()).toContain("organizations/autonoco/settings/apps/new");
    expect(s.said.some((l) => l.includes("assuming it is"))).toBe(true);
  });

  test("no worker found ⇒ nothing written, the values come back for the user to set", async () => {
    const gh = fakeGithub();
    const s = seamsWith(gh, false);
    const result = await runGithubSetup({ ...INPUT, printSecrets: true }, s.seams);
    expect(result.vars).toEqual({
      written: false,
      missing: ["GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_REPO"],
    });
    expect(result.secrets).toBe("printed");
    expect(result.secretValues).toEqual({
      GITHUB_APP_PRIVATE_KEY: pem,
      GITHUB_WEBHOOK_SECRET: "whsec",
    });
  });

  test("verification reports false when the token cannot read the repo; setup still completes", async () => {
    const gh = fakeGithub({ repoStatus: 404 });
    const s = seamsWith(gh, true);
    const result = await runGithubSetup(INPUT, s.seams);
    expect(result.verified).toBe(false);
    expect(result.secrets).toBe("written");
  });

  test("an installation that never appears is E_CONNECTOR with the install URL", async () => {
    const gh = fakeGithub({ installAfterPolls: 1_000 });
    const s = seamsWith(gh, true);
    let t = Date.now();
    s.seams.now = () => (t += 4 * 60_000); // each poll ages the clock four minutes
    s.seams.timeoutMs = 10 * 60_000;
    const err = (await runGithubSetup(INPUT, s.seams).catch((e: unknown) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("E_CONNECTOR");
    expect(err.hint).toContain("installations/new");
  });

  test("a bad hub URL fails before anything opens", async () => {
    const gh = fakeGithub();
    const s = seamsWith(gh, true);
    await expect(
      runGithubSetup({ ...INPUT, hubUrl: "https://app.example" }, s.seams),
    ).rejects.toThrow("_pinbox");
    expect(s.opened).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  test("a repo that is not owner/name fails before anything opens", async () => {
    const gh = fakeGithub();
    const s = seamsWith(gh, true);
    for (const repo of ["pinbox", "autonoco/pinbox/extra", "autonoco/ pinbox", "autonoco/"]) {
      const err = (await runGithubSetup({ ...INPUT, repo }, s.seams).catch((e) => e)) as CliError;
      expect(err).toBeInstanceOf(CliError);
      expect(err.code).toBe("E_INVALID_INPUT");
    }
    expect(s.opened).toEqual([]);
    expect(gh.calls).toEqual([]);
    expect(s.vars).toEqual([]);
  });
});
