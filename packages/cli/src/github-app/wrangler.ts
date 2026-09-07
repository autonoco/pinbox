// pinbox CLI — the worker-side writes of `pinbox github setup`: find the scaffolded hub,
// patch its wrangler.jsonc vars, push the two secrets through wrangler. Bun APIs: this is a
// process we launch.
import { patchWranglerVars } from "./manifest.ts";

const CONFIG_NAMES = ["wrangler.jsonc", "wrangler.json"];

/**
 * The hub worker's directory: the cwd, or the nearest directory under it (up to four levels,
 * node_modules skipped) whose wrangler config names `PinboxHubDO`. Null when the repo has
 * no scaffolded hub — the values are then printed for wherever the worker lives.
 */
export async function findWorkerDir(cwd: string): Promise<string | null> {
  if ((await configIn(cwd)) !== null) return cwd;
  const glob = new Bun.Glob("{*,*/*,*/*/*,*/*/*/*}/wrangler.json{,c}");
  const found: string[] = [];
  for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: false })) {
    if (rel.includes("node_modules/")) continue;
    const dir = `${cwd}/${rel.slice(0, rel.lastIndexOf("/"))}`;
    if ((await configIn(dir)) !== null) found.push(dir);
  }
  found.sort((a, b) => a.length - b.length); // the shallowest match wins
  return found[0] ?? null;
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

/**
 * `wrangler secret put NAME` with the value on stdin — never on argv, never echoed. Resolves
 * false (with the reason on stderr) when wrangler cannot do it — not logged in, no network —
 * so the caller falls back to printing the value instead of failing the whole setup.
 */
export async function putSecret(workerDir: string, name: string, value: string): Promise<boolean> {
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
  if (exitCode === 0) return true;
  console.error(
    `wrangler secret put ${name} failed (exit ${exitCode}): ${stderr.trim().slice(0, 300)}`,
  );
  return false;
}
