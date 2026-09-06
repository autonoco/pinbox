// pinbox CLI — the worker-side writes of `pinbox github setup`: find the scaffolded hub,
// patch its wrangler.jsonc vars, push the two secrets through wrangler. Bun APIs: this is a
// process we launch.
import { CliError } from "../errors.ts";
import { patchWranglerVars } from "./manifest.ts";

const CONFIG_NAMES = ["wrangler.jsonc", "wrangler.json"];

/**
 * The hub worker's directory: `--worker` when given; else the cwd or one of its immediate
 * subdirectories whose wrangler config names `PinboxHubDO`.
 */
export async function findWorkerDir(cwd: string, explicit?: string): Promise<string | null> {
  if (explicit !== undefined) {
    const dir = explicit.startsWith("/") ? explicit : `${cwd}/${explicit}`;
    return (await configIn(dir)) === null ? null : dir;
  }
  if ((await configIn(cwd)) !== null) return cwd;
  const glob = new Bun.Glob("*/wrangler.json{,c}");
  for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: false })) {
    const dir = `${cwd}/${rel.slice(0, rel.lastIndexOf("/"))}`;
    if ((await configIn(dir)) !== null) return dir;
  }
  return null;
}

/** The config file in `dir` that names the hub DO, or null. */
export async function configIn(dir: string): Promise<string | null> {
  for (const name of CONFIG_NAMES) {
    const file = Bun.file(`${dir}/${name}`);
    if (!(await file.exists())) continue;
    if ((await file.text()).includes("PinboxHubDO")) return `${dir}/${name}`;
  }
  return null;
}

/** Patch the vars in place; returns the names it could not find (older templates). */
export async function writeWranglerVars(
  configPath: string,
  vars: Record<string, string>,
): Promise<string[]> {
  const before = await Bun.file(configPath).text();
  const { text, missing } = patchWranglerVars(before, vars);
  if (text !== before) await Bun.write(configPath, text);
  return missing;
}

/** The wrangler this worker pins, else a pinned bunx — never whatever is on PATH. */
async function wranglerCommand(workerDir: string): Promise<string[]> {
  const local = `${workerDir}/node_modules/.bin/wrangler`;
  if (await Bun.file(local).exists()) return [local];
  return ["bunx", "wrangler@4"];
}

/** `wrangler secret put NAME` with the value on stdin — never on argv, never echoed. */
export async function putSecret(workerDir: string, name: string, value: string): Promise<void> {
  const cmd = await wranglerCommand(workerDir);
  const proc = Bun.spawn([...cmd, "secret", "put", name], {
    cwd: workerDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(value);
  proc.stdin.end();
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new CliError(
      "E_CONNECTOR",
      `wrangler secret put ${name} failed (exit ${exitCode}): ${stderr.trim().slice(0, 300)}`,
      "run `wrangler login` in the worker directory, or pass --print-secrets to set them yourself",
    );
  }
}
