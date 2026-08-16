// pinbox CLI — replace the running compiled binary from a GitHub Release.
// Same shape as autonoco/buttons: download, sha256, atomic rename. Next invocation
// is the new binary; this process keeps running the inode it already mapped.
import { $ } from "bun";

const REPO = "autonoco/pinbox";

export type ApplyResult = {
  current: string;
  latest: string;
  updated: boolean;
};

export function releaseAssetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "arm64" && arch !== "x64")) {
    return null;
  }
  return `pinbox-${platform}-${arch}`;
}

export function isHomebrewManaged(path: string): boolean {
  return path.includes("/Cellar/") || path.includes("/opt/homebrew/");
}

export function parseSha256(checksums: string, asset: string): string | null {
  for (const line of checksums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (hash !== undefined && name === asset) return hash;
  }
  return null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function atomicReplace(dest: string, bytes: Uint8Array): Promise<void> {
  const slash = dest.lastIndexOf("/");
  const dir = slash === -1 ? "." : dest.slice(0, slash);
  const tmp = `${dir}/.pinbox-update-${Date.now()}`;
  const old = `${dest}.old`;
  await Bun.write(tmp, bytes);
  await $`chmod 700 ${tmp}`.quiet();
  await $`rm -f ${old}`.quiet();
  if ((await $`mv ${dest} ${old}`.quiet().nothrow()).exitCode !== 0) {
    await $`rm -f ${tmp}`.quiet();
    throw new Error(`cannot move current binary: ${dest}`);
  }
  if ((await $`mv ${tmp} ${dest}`.quiet().nothrow()).exitCode !== 0) {
    await $`mv ${old} ${dest}`.quiet();
    throw new Error(`cannot install new binary: ${dest}`);
  }
  await $`rm -f ${old}`.quiet();
}

export async function applyBinaryUpdate(opts: {
  current: string;
  latest: string;
  dest: string;
  fetchImpl?: typeof fetch | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<ApplyResult> {
  const asset = releaseAssetName();
  if (asset === null) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  if (isHomebrewManaged(opts.dest)) {
    throw new Error("this binary is managed by Homebrew; run `brew upgrade pinbox` instead");
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const base = `https://github.com/${REPO}/releases/download/v${opts.latest}`;
  log(`Updating pinbox ${opts.current} -> ${opts.latest}`);
  const bytes = new Uint8Array(await getBuffer(`${base}/${asset}`, fetchImpl));
  const sums = new TextDecoder().decode(await getBuffer(`${base}/${asset}.sha256`, fetchImpl));
  const expected = parseSha256(sums, asset);
  if (expected === null) throw new Error(`no checksum entry for ${asset}`);
  const actual = sha256Hex(bytes);
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}`);
  log(` replacing ${opts.dest}`);
  await atomicReplace(opts.dest, bytes);
  return { current: opts.current, latest: opts.latest, updated: true };
}

async function getBuffer(url: string, fetchImpl: typeof fetch): Promise<ArrayBuffer> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`);
  return res.arrayBuffer();
}
