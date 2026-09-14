// Guest runtime: Vite loads this under Node as well as Bun. Git/state stays in the CLI.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ViteDevServer } from "vite";
export const PREVIEWS_PATH = "/__pinbox_previews";

export function servePreviews(server: ViteDevServer, cwd: string, executable: string): void {
  server.middlewares.use((req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path !== PREVIEWS_PATH && path !== `${PREVIEWS_PATH}/identity`) return next();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    // Browser-only same-origin reads. No filesystem or process controls are exposed.
    if (req.method !== "GET" || req.headers["sec-fetch-site"] === "cross-site") {
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, error: { message: "same-origin GET required" } }));
      return;
    }
    if (path === `${PREVIEWS_PATH}/identity`) {
      res.end(
        JSON.stringify({
          id: createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 12),
        }),
      );
      return;
    }
    execFile(
      executable,
      ["preview", "list", "--json"],
      { cwd, timeout: 6000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          res.statusCode = 503;
          res.end(
            JSON.stringify({
              ok: false,
              error: { message: "Preview discovery unavailable. Update the Pinbox CLI." },
            }),
          );
        } else {
          try {
            JSON.parse(stdout);
            res.end(stdout);
          } catch {
            res.statusCode = 503;
            res.end('{"ok":false}');
          }
        }
      },
    );
  });
}
