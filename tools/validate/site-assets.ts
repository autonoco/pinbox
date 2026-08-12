// tools/validate — every local asset apps/web references must exist on disk.
//
// The site has no build step, which is the point: `public/` deploys byte for byte. The cost of
// that is nothing resolves imports for you, so a renamed font or a moved stylesheet fails
// *silently* — the browser falls back to a system face and the page still loads, looking almost
// right. This is what notices.
import { fileURLToPath } from "node:url";

// fileURLToPath, not `.pathname`: the latter stays percent-encoded, so a checkout under a path
// with a space reads as `%20` and every file lookup misses.
const root = fileURLToPath(new URL("../..", import.meta.url));
const siteRoot = `${root}apps/web/public`;

/** `href`/`src` in either quote style, and `url(…)` with or without quotes. */
const REFERENCE = /(?:href|src)=(?:"([^"#?]+)"|'([^'#?]+)')|url\(\s*["']?([^"')?#]+)["']?\s*\)/g;

/** Absolute (http:, data:, mailto:, //cdn) references are somebody else's problem. */
function isExternal(reference: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith("//");
}

const all = [...new Bun.Glob("**/*").scanSync({ cwd: siteRoot, dot: true })].map(
  (path) => `/${path}`,
);
const present = new Set(all);
const sources = all.filter((path) => path.endsWith(".html") || path.endsWith(".css"));

const broken: string[] = [];
for (const source of sources) {
  const text = await Bun.file(`${siteRoot}${source}`).text();
  for (const match of text.matchAll(REFERENCE)) {
    const reference = match[1] ?? match[2] ?? match[3];
    if (reference === undefined || reference.length === 0 || isExternal(reference)) continue;

    // A relative reference resolves against the file that names it, exactly as a browser does.
    const sourceDir = source.slice(0, source.lastIndexOf("/"));
    const resolved = reference.startsWith("/")
      ? reference
      : new URL(reference, `file://${sourceDir}/`).pathname;

    // A directory reference (`/demo/`) resolves to its index.html, the same way the asset handler
    // resolves it in production.
    const candidates = resolved.endsWith("/")
      ? [`${resolved}index.html`]
      : [resolved, `${resolved}/index.html`];
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
