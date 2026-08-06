// Git-hook + gitignore writer tests: the post-commit payload is compiled in (no assetsDir
// seam — reading it off disk is the bug), existing hooks are never clobbered, and the
// .pinbox/ gitignore entry is idempotent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { GIT_HOOK_ASSET } from "./git-hook-asset.ts";
import { ensureGitignore, installGitHook } from "./hooks-install.ts";

const tmpRoot = `${process.env["TMPDIR"] ?? "/tmp"}/pinbox-hooks-${crypto.randomUUID()}`;

async function gitProject(name: string): Promise<string> {
  const dir = `${tmpRoot}/${name}`;
  await $`mkdir -p ${dir}`.quiet();
  await $`git -C ${dir} init -q`.quiet();
  return dir;
}

beforeAll(async () => {
  await $`mkdir -p ${tmpRoot}`.quiet();
});

afterAll(async () => {
  await $`rm -rf ${tmpRoot}`.quiet();
});

describe("installGitHook", () => {
  test("no git repo → skipped-no-git", async () => {
    const dir = `${tmpRoot}/plain`;
    await $`mkdir -p ${dir}`.quiet();
    expect(await installGitHook(dir)).toBe("skipped-no-git");
  });

  test("installs the embedded payload 0755; second run keeps the existing hook", async () => {
    const dir = await gitProject("embedded");
    expect(await installGitHook(dir)).toBe("installed");
    const hook = Bun.file(`${dir}/.git/hooks/post-commit`);
    expect(await hook.text()).toBe(GIT_HOOK_ASSET.contents);
    expect((await hook.stat()).mode & 0o777).toBe(0o755);
    expect(await installGitHook(dir)).toBe("kept");
  });

  test("the embedded payload is the trailer hook, not a placeholder", () => {
    // The failure mode this guards is an install that "succeeds" with the wrong bytes.
    expect(GIT_HOOK_ASSET.name).toBe("post-commit");
    expect(GIT_HOOK_ASSET.contents).toContain("session trailer");
    expect(GIT_HOOK_ASSET.contents.startsWith("#!/bin/sh")).toBe(true);
  });

  test("dry-run writes nothing", async () => {
    const dir = await gitProject("dry");
    expect(await installGitHook(dir, { dryRun: true })).toBe("installed");
    expect(await Bun.file(`${dir}/.git/hooks/post-commit`).exists()).toBe(false);
  });

  test("a pre-existing user hook is never clobbered", async () => {
    const dir = await gitProject("user-hook");
    const userHook = "#!/bin/sh\necho mine\n";
    await Bun.write(`${dir}/.git/hooks/post-commit`, userHook);
    expect(await installGitHook(dir)).toBe("kept");
    expect(await Bun.file(`${dir}/.git/hooks/post-commit`).text()).toBe(userHook);
  });
});

describe("ensureGitignore", () => {
  test("missing .gitignore is created with the .pinbox/ entry", async () => {
    const dir = `${tmpRoot}/gi-create`;
    await $`mkdir -p ${dir}`.quiet();
    expect(await ensureGitignore(dir)).toBe("created");
    expect(await Bun.file(`${dir}/.gitignore`).text()).toBe(".pinbox/\n");
    expect(await ensureGitignore(dir)).toBe("unchanged");
  });

  test("existing .gitignore gets the entry appended once, even without a trailing newline", async () => {
    const dir = `${tmpRoot}/gi-append`;
    await $`mkdir -p ${dir}`.quiet();
    await Bun.write(`${dir}/.gitignore`, "node_modules");
    expect(await ensureGitignore(dir)).toBe("appended");
    expect(await Bun.file(`${dir}/.gitignore`).text()).toBe("node_modules\n.pinbox/\n");
    expect(await ensureGitignore(dir)).toBe("unchanged");
    expect(await Bun.file(`${dir}/.gitignore`).text()).toBe("node_modules\n.pinbox/\n");
  });
});
