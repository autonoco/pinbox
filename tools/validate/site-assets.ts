// tools/validate — every local asset apps/web references must exist on disk.
//
// The site has no build step, which is the point: `public/` deploys byte for byte. The cost of
// that is nothing resolves imports for you, so a renamed font or a moved stylesheet fails
// *silently* — the browser falls back to a system face and the page still loads, looking almost
// right. This is what notices.
import { readdir } from "node:fs/promises";

const root = new URL("../..", import.meta.url).pathname;
const siteRoot = `${root}apps/web/public`;

/** `href="/x"`, `src="/x"`, and `url("/x")` — the three ways this site names a local file. */
const REFERENCE = /(?:href|src)="(\/[^"#?]+)"|url\(["']?(\/[^"')?#]+)["']?\)/g;

async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(`${dir}/${entry.name}`, relative)));
    else found.push(relative);
  }
  return found;
}

const all = await filesUnder(siteRoot);
const present = new Set(all);
const sources = all.filter((path) => path.endsWith(".html") || path.endsWith(".css"));

const broken: string[] = [];
for (const source of sources) {
  const text = await Bun.file(`${siteRoot}${source}`).text();
  for (const match of text.matchAll(REFERENCE)) {
    const reference = match[1] ?? match[2];
    if (reference === undefined) continue;
    // A directory reference (`/demo/`) resolves to its index.html, the same way the asset
    // handler resolves it in production.
    const candidates = reference.endsWith("/")
      ? [`${reference}index.html`]
      : [reference, `${reference}/index.html`];
    if (!candidates.some((candidate) => present.has(candidate))) {
      broken.push(`${source} → ${reference}`);
    }
  }
}

if (broken.length > 0) {
  console.error("apps/web references files that do not exist:\n");
  for (const entry of broken) console.error(`  ${entry}`);
  console.error(`\nAdd the file, or fix the path. Checked ${sources.length} HTML/CSS files.`);
  process.exit(1);
}

console.log(`apps/web: ${sources.length} HTML/CSS files, every local reference resolves.`);
