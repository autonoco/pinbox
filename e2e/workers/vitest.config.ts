// The one non-`bun test` suite in the repo: @cloudflare/vitest-pool-workers IS workerd
// The DO SQLite adapter must be exercised on the runtime it
// ships to. Files are named *.worker-test.ts so `bun test` at the root never discovers
// them; this config includes only that pattern, split across two pool projects:
//   - "do":       inline miniflare config driving core's DO classes directly
//   - "template": the real `examples/worker` wrangler.jsonc (alias + rules included),
//                 so the deploy-checked template copy is what the tests exercise
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            main: here("./fixtures/test-worker.ts"),
            miniflare: {
              compatibilityDate: "2026-08-01", // pinned; matches the worker template
              durableObjects: {
                STORE_DO: { className: "StoreDo", useSQLite: true },
                HUB_DO: { className: "PinboxHubDO", useSQLite: true },
                // strategy-parity coverage: same DO, env forced to none/ALLOW_UNAUTHENTICATED=1
                HUB_DO_NONE: { className: "PinboxHubDONone", useSQLite: true },
                // Task 6 auth matrix: the rows that need their own namespace env —
                // none-without-opt-in (fails closed) and jwt (JWKS via stubbed fetch)
                HUB_DO_NONE_REFUSED: { className: "PinboxHubDONoneRefused", useSQLite: true },
                HUB_DO_JWT: { className: "PinboxHubDOJwt", useSQLite: true },
              },
              r2Buckets: ["MEDIA"],
              bindings: {
                // token strategy under test; the auth matrix (none/jwt) is Task 6's suite
                AUTH_STRATEGY: "token",
                PINBOX_TOKEN: "test-token",
                // fixed fake S3 credentials — presigning is pure computation, nothing dials out
                R2_ACCOUNT_ID: "acct1234",
                R2_BUCKET: "pinbox-media",
                R2_ACCESS_KEY_ID: "AKIDEXAMPLEKEY0001",
                R2_SECRET_ACCESS_KEY: "secretsecretsecretsecret0001",
              },
            },
          }),
        ],
        resolve: {
          alias: {
            // hub.ts → store.ts carries a top-level `import { Database } from "bun:sqlite"`.
            // The DO adapter never calls openStore, but the bundler must still resolve the
            // specifier (same load-bearing alias as the worker template's wrangler.jsonc).
            "bun:sqlite": here("./fixtures/bun-sqlite.ts"),
          },
        },
        test: {
          name: "do",
          root: here("."),
          include: ["**/*.worker-test.ts"],
          exclude: [...configDefaults.exclude, "**/template.worker-test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            // The real template copy: main, DO binding, migrations, vars, Text rule and
            // the bun:sqlite alias all come from the deploy-checked wrangler.jsonc.
            wrangler: { configPath: here("../../examples/worker/wrangler.jsonc") },
            miniflare: {
              bindings: {
                // a secret in production (`wrangler secret put PINBOX_TOKEN`); test var here
                PINBOX_TOKEN: "test-token",
                // zero-touch staging injection under test; the origin is a stubbed fetch
                ORIGIN_URL: "https://origin.test",
              },
              // Mirror of the template's wrangler `rules` for the vite side of the pool:
              // wrangler's own bundler honors the config rule at deploy; the test bundler
              // needs the same statement to import the IIFE as text.
              modulesRules: [{ type: "Text", include: ["**/*.iife.js"] }],
            },
          }),
        ],
        resolve: {
          alias: {
            // Test the template against core *source* (like every other worker project);
            // `wrangler deploy --dry-run` covers resolution through the published dist.
            "@autono/pinbox-core/do": here("../../packages/core/src/do.ts"),
            "bun:sqlite": here("../../examples/worker/src/shims/bun-sqlite.ts"),
          },
        },
        test: {
          name: "template",
          root: here("."),
          // loop-parity runs in BOTH projects: its SELF-driven flow here, its
          // per-namespace auth-matrix rows in "do" (each mode skips the other's blocks).
          include: ["**/template.worker-test.ts", "**/loop-parity.worker-test.ts"],
        },
      },
    ],
  },
});
