// pinbox CLI — `pinbox github setup`, orchestrated.
// One command takes a repo from "no App" to "cloud hub linked to GitHub": create the App
// from a manifest (browser: one click), install it (browser: one click), discover the
// installation, write the three vars into the worker's wrangler config, push the two
// secrets through wrangler, and prove the pair works by reading the repo with an
// installation token. Every side effect is a seam so the flow is testable end to end
// without a browser, a GitHub, or wrangler; commands/github.ts binds the real ones.
import {
  type FetchLike,
  githubHeaders,
  mintInstallationToken,
  signAppJwt,
} from "@autono/pinbox-core/connectors";
import { CliError } from "../errors.ts";
import {
  buildManifest,
  type Installation,
  manifestFormHtml,
  manifestTarget,
  normalizeHubUrl,
  pickInstallation,
  randomState,
  webhookUrl,
} from "./manifest.ts";

export type SetupInput = {
  hubUrl: string;
  repo: string;
  appName: string;
  apiBase?: string;
};

export type SetupSeams = {
  fetchImpl: FetchLike;
  /** Open a URL in the user's browser (or print it). */
  open(url: string): Promise<void>;
  /** Serve the manifest form and wait for GitHub's code. */
  receive(formHtml: (origin: string) => string, state: string): Promise<string>;
  /** Progress lines, stderr. */
  say(line: string): void;
  /** Worker writes; null ⇒ no worker found, the values are printed instead. */
  worker: {
    dir: string;
    writeVars(vars: Record<string, string>): Promise<string[]>;
    /** False when wrangler could not set it; the flow then prints the values instead. */
    putSecret(name: string, value: string): Promise<boolean>;
  } | null;
  now?: () => number;
  /** How long to wait for each browser step. */
  timeoutMs?: number;
  /** Poll cadence while waiting for the installation. */
  pollMs?: number;
};

export type SetupResult = {
  appId: string;
  slug: string;
  appUrl: string;
  installationId: string;
  repo: string;
  hubUrl: string;
  webhookUrl: string;
  workerDir: string | null;
  /** Vars written into wrangler config, or the ones the user must add by hand. */
  vars: { written: boolean; missing: string[] };
  secrets: "written" | "printed";
  /** Only when printed: the values the user must set (never present when written). */
  secretValues?: { GITHUB_APP_PRIVATE_KEY: string; GITHUB_WEBHOOK_SECRET: string };
  verified: boolean;
};

type Conversion = {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  html_url: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 3_000;

export async function runGithubSetup(input: SetupInput, seams: SetupSeams): Promise<SetupResult> {
  const hub = normalizeHubUrl(input.hubUrl);
  // The same shape the connector enforces on GITHUB_REPO — reject it here, not after the
  // App exists and a bad value sits in wrangler.jsonc.
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repo)) {
    throw new CliError(
      "E_INVALID_INPUT",
      `repository must be "owner/name", got "${input.repo}"`,
      "the origin remote should point at github.com/<owner>/<name>",
    );
  }
  const api = (input.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const owner = input.repo.split("/")[0] as string;

  const org = await ownerOrganization(api, owner, seams);
  const app = await createApp(input, hub, api, org, seams);
  seams.say(`Install the App on ${owner} and select ${input.repo} — opening GitHub.`);
  await seams.open(`${app.html_url}/installations/new`);
  const installation = await awaitInstallation(
    api,
    app,
    owner,
    seams,
    seams.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  seams.say(`Installed: installation ${installation.id} on ${owner}.`);

  const written = await configureWorker(input, app, installation, seams);
  const verified = await verifyAccess(api, app, installation, input.repo, seams);
  seams.say(verified ? `Verified: the App can read ${input.repo}.` : "Verification failed.");

  const result: SetupResult = {
    appId: String(app.id),
    slug: app.slug,
    appUrl: app.html_url,
    installationId: String(installation.id),
    repo: input.repo,
    hubUrl: hub,
    webhookUrl: webhookUrl(hub),
    workerDir: seams.worker?.dir ?? null,
    ...written,
    verified,
  };
  if (written.secrets === "printed") {
    result.secretValues = {
      GITHUB_APP_PRIVATE_KEY: app.pem,
      GITHUB_WEBHOOK_SECRET: app.webhook_secret,
    };
  }
  return result;
}

/** Step 1: the manifest round trip — GitHub shows a review page, the user clicks Create. */
async function createApp(
  input: SetupInput,
  hub: string,
  api: string,
  org: string | null,
  seams: SetupSeams,
): Promise<Conversion> {
  const state = randomState();
  seams.say(`Creating GitHub App "${input.appName}" — your browser will open GitHub.`);
  const code = await seams.receive((origin) => {
    const manifest = buildManifest({
      name: input.appName,
      hubUrl: hub,
      redirectUrl: `${origin}/callback`,
    });
    return manifestFormHtml(manifestTarget(org, state), manifest);
  }, state);
  const app = await convert(api, code, seams.fetchImpl);
  seams.say(`App created: ${app.html_url} (id ${app.id})`);
  return app;
}

/**
 * GitHub has two creation pages — an organization's and a user's — and posting to the wrong
 * one 404s. The owner's public profile says which it is; if that lookup fails (offline,
 * rate-limited) the organization page is the better bet for a team repo, and we say so.
 */
async function ownerOrganization(
  api: string,
  owner: string,
  seams: SetupSeams,
): Promise<string | null> {
  try {
    const res = await seams.fetchImpl(`${api}/users/${encodeURIComponent(owner)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "pinbox" },
    });
    if (res.ok) {
      const body = (await res.json()) as { type?: string };
      return body.type === "Organization" ? owner : null;
    }
  } catch {
    // fall through
  }
  seams.say(`Could not tell whether ${owner} is an organization — assuming it is.`);
  return owner;
}

/** Step 3: vars into wrangler.jsonc, secrets through wrangler — or nothing, when no worker. */
async function configureWorker(
  input: SetupInput,
  app: Conversion,
  installation: Installation,
  seams: SetupSeams,
): Promise<Pick<SetupResult, "vars" | "secrets">> {
  const vars = {
    GITHUB_APP_ID: String(app.id),
    GITHUB_INSTALLATION_ID: String(installation.id),
    GITHUB_REPO: input.repo,
  };
  if (seams.worker === null) {
    return { vars: { written: false, missing: Object.keys(vars) }, secrets: "printed" };
  }
  const missing = await seams.worker.writeVars(vars);
  const key = await seams.worker.putSecret("GITHUB_APP_PRIVATE_KEY", app.pem);
  const hook = key && (await seams.worker.putSecret("GITHUB_WEBHOOK_SECRET", app.webhook_secret));
  if (!key || !hook)
    seams.say("wrangler could not set the secrets — printing them for you to set.");
  return { vars: { written: true, missing }, secrets: key && hook ? "written" : "printed" };
}

async function convert(api: string, code: string, fetchImpl: FetchLike): Promise<Conversion> {
  const res = await fetchImpl(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "pinbox" },
  });
  if (!res.ok) {
    throw new CliError(
      "E_CONNECTOR",
      `GitHub rejected the manifest code: HTTP ${res.status}`,
      "the code is single-use and short-lived; re-run `pinbox github setup`",
    );
  }
  const body = (await res.json()) as Partial<Conversion>;
  if (
    typeof body.id !== "number" ||
    typeof body.slug !== "string" ||
    typeof body.pem !== "string" ||
    typeof body.webhook_secret !== "string" ||
    typeof body.html_url !== "string"
  ) {
    throw new CliError("E_CONNECTOR", "GitHub's manifest conversion response was incomplete");
  }
  return body as Conversion;
}

/** Poll GET /app/installations with the App JWT until the owner's installation shows up. */
async function awaitInstallation(
  api: string,
  app: Conversion,
  owner: string,
  seams: SetupSeams,
  timeoutMs: number,
): Promise<Installation> {
  const now = seams.now ?? (() => Date.now());
  const started = now();
  const pollMs = seams.pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    const jwt = await signAppJwt(String(app.id), app.pem, now);
    const res = await seams.fetchImpl(`${api}/app/installations?per_page=100`, {
      headers: githubHeaders(jwt),
    });
    if (res.ok) {
      const found = pickInstallation((await res.json()) as Installation[], owner);
      if (found !== null) return found;
    }
    if (now() - started > timeoutMs) {
      throw new CliError(
        "E_CONNECTOR",
        `no installation of ${app.slug} on ${owner} appeared within ${Math.round(timeoutMs / 60_000)} min`,
        `install it at ${app.html_url}/installations/new — then re-run; the App already exists, GitHub will offer to reuse it`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function verifyAccess(
  api: string,
  app: Conversion,
  installation: Installation,
  repo: string,
  seams: SetupSeams,
): Promise<boolean> {
  try {
    const now = seams.now ?? (() => Date.now());
    const jwt = await signAppJwt(String(app.id), app.pem, now);
    const token = await mintInstallationToken(api, String(installation.id), jwt, seams.fetchImpl);
    const res = await seams.fetchImpl(`${api}/repos/${repo}`, {
      headers: githubHeaders(token.token),
    });
    return res.ok;
  } catch {
    return false;
  }
}
