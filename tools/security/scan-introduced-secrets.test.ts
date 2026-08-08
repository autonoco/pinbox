// A secret scan that silently scans nothing still reports success, so the failure this file
// guards is a green check that means nothing: a shallow checkout with no history to range over,
// or the range logic degrading to "scan one commit" when a real base exists. Neither is visible
// in a YAML syntax check, and both only matter on the day someone actually commits a key.
import { describe, expect, test } from "bun:test";

const root = new URL("../..", import.meta.url).pathname;
const workflow = await Bun.file(`${root}.github/workflows/secret-scan.yml`).text();

describe("secret-scan workflow", () => {
  test("scans full history and never persists a token to do it", () => {
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
  });

  test("keeps the scanner invocation out of YAML, and workflow context out of the shell", () => {
    expect(workflow).toContain("bun tools/security/scan-introduced-secrets.ts");
    expect(workflow).not.toContain("docker run");
    expect(workflow).not.toContain("--log-opts");

    // The head SHA is attacker-set on a fork PR; it reaches the script through env or not at all.
    const parsed = Bun.YAML.parse(workflow) as {
      jobs: Record<string, { steps?: { run?: string; env?: Record<string, string> }[] }>;
    };
    const steps = parsed.jobs["gitleaks"]?.steps ?? [];
    const scan = steps.find((step) => (step.run ?? "").includes("scan-introduced-secrets"));
    expect(scan, "the gitleaks job must run the scanner script").toBeDefined();
    expect(scan?.run).not.toContain("${{");
    expect(Object.keys(scan?.env ?? {}).sort()).toEqual(["BASE_SHA", "HEAD_SHA"]);
  });

  test("the required-check name matches the job the branch rule names", () => {
    const parsed = Bun.YAML.parse(workflow) as { jobs: Record<string, { name?: string }> };
    expect(parsed.jobs["gitleaks"]?.name).toBe("gitleaks");
  });
});

describe("introduced-secret scan", () => {
  test("bounds the range, and treats a missing predecessor as one commit", async () => {
    const { selectGitleaksLogOpts } = await import("./scan-introduced-secrets.ts");
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    expect(selectGitleaksLogOpts(base, head)).toBe(`${base}..${head}`);
    // A branch's first push, and a manual run: no predecessor, so scan the head commit alone.
    expect(selectGitleaksLogOpts("0".repeat(40), head)).toBe(head);
    expect(selectGitleaksLogOpts(undefined, head)).toBe(head);
    expect(() => selectGitleaksLogOpts(base, "not-a-sha")).toThrow("invalid HEAD_SHA");
    expect(() => selectGitleaksLogOpts("; rm -rf /", head)).toThrow("invalid BASE_SHA");
  });

  test("builds a fixed argument vector, pinned image, no shell", async () => {
    const { buildGitleaksArgs } = await import("./scan-introduced-secrets.ts");
    const head = "b".repeat(40);

    expect(buildGitleaksArgs(null, "/workspace", head)).toEqual([
      "docker",
      "run",
      "--rm",
      "-v",
      "/workspace:/repo",
      "-w",
      "/repo",
      "ghcr.io/gitleaks/gitleaks:v8.30.1",
      "git",
      "--redact",
      "--no-banner",
      `--log-opts=${head}`,
      ".",
    ]);

    // A machine with gitleaks installed skips Docker, so `bun run scan:secrets` works locally.
    expect(buildGitleaksArgs("/usr/bin/gitleaks", "/workspace", head)).toEqual([
      "/usr/bin/gitleaks",
      "git",
      "--redact",
      "--no-banner",
      `--log-opts=${head}`,
      "/workspace",
    ]);
  });

  test("the allowlist is fingerprints, so an ignore cannot widen past the line it names", async () => {
    const text = await Bun.file(`${root}.gitleaksignore`).text();
    const entries = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(entries.length).toBeGreaterThan(0);
    // commit:path:rule:line — anything looser silences a whole file or rule forever.
    for (const entry of entries) {
      expect(entry, `${entry} is not a gitleaks fingerprint`).toMatch(
        /^[0-9a-f]{40,64}:[^:]+:[\w-]+:\d+$/,
      );
    }
  });
});
