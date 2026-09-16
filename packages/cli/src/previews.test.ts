import { afterEach, expect, test } from "bun:test";
import { projectId } from "./paths.ts";
import { listPreviews, previewOrigin, registerPreview, worktrees } from "./previews.ts";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) await Bun.$`rm -rf ${root}`.quiet();
});
async function repo() {
  const root = (await Bun.$`mktemp -d`.text()).trim();
  roots.push(root);
  await Bun.$`git init -b main ${root}`.quiet();
  await Bun.$`git -C ${root} -c user.name=Test -c user.email=test@example.test commit --allow-empty -m initial`.quiet();
  return root;
}
test("worktree discovery, current identity, stopped preview and changed branch", async () => {
  const root = await repo();
  const child = `${root}/branch with spaces`;
  await Bun.$`git -C ${root} worktree add -b topic ${child}`.quiet();
  expect(worktrees(root).map((w) => w.branch)).toEqual(["main", "topic"]);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ id: projectId(child) }),
  });
  servers.push(server);
  await registerPreview(child, {
    url: "https://review.example.test",
    localUrl: server.url.origin,
    label: "PR #7",
    backend: "Shared development backend",
  });
  const items = await listPreviews(root);
  expect(items.find((p) => p.current)?.branch).toBe("main");
  expect(items.find((p) => p.branch === "topic")).toMatchObject({ ready: true, label: "PR #7" });
  expect((await listPreviews(child)).find((p) => p.current)?.label).toBe("PR #7");
  server.stop(true);
  expect((await listPreviews(root)).find((p) => p.branch === "topic")?.ready).toBe(false);
  await Bun.$`git -C ${child} switch -c other`.quiet();
  expect((await listPreviews(root)).find((p) => p.branch === "other")?.url).toBeUndefined();
});
test("registration rejects executable URLs, credentials, paths and non-loopback probes", () => {
  for (const value of [
    "javascript:alert(1)",
    "https://u:p@example.test",
    "http://example.test/path",
    "http://example.test?x=1",
  ])
    expect(() => previewOrigin(value)).toThrow();
  expect(() => previewOrigin("http://169.254.169.254", true)).toThrow();
  expect(previewOrigin("http://[::1]:5741", true)).toBe("http://[::1]:5741");
});
test("readiness probes never follow redirects to other hosts", async () => {
  const root = await repo();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.redirect("http://169.254.169.254"),
  });
  servers.push(server);
  await registerPreview(root, {
    url: "https://review.example.test",
    localUrl: server.url.origin,
    label: "Main",
    backend: "",
  });
  expect((await listPreviews(root))[0]?.ready).toBe(false);
});
