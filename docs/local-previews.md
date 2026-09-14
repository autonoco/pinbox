# Local worktree previews

The Vite toolbar can switch between registered frontend previews of the same Git repository.
Each Git worktree retains its own Pinbox hub, database, and agent sessions. Selecting a preview
navigates only the current browser and preserves the path, query, and fragment. It never checks
out a branch, changes another browser, starts a backend, or merges a PR.

Enable with `pinbox({ previews: true })`, or set `PINBOX_PREVIEWS=1` in the Vite process.
The local CLI must support `pinbox preview`; `previewExecutable` (or
`PINBOX_PREVIEW_EXECUTABLE`) can select a development CLI binary. The switcher is Vite-only
and excluded from production builds. Its read-only same-origin endpoint exposes labels and
URLs, not worktree paths, credentials, or process controls.

For each branch:

1. Create a worktree with `git worktree add ../app-topic -b topic`.
2. Install dependencies and use the app's established frontend startup command on its own port.
3. Enable the Pinbox Vite plugin and preview option in that process. Configure its tunnel/origin
   using the application's existing access controls. A remote reviewer needs a reachable URL;
   their browser cannot use the host machine's localhost.
4. Run `pinbox init` in the worktree if necessary, so `.pinbox/` stays ignored.
5. Register the running preview from its worktree:

```sh
pinbox preview register --url https://topic.example.com --local-url http://localhost:5174 \
  --label 'PR #104 — Inbox' --pr https://github.com/example/app/pull/104 \
  --backend 'Shared development backend' --json
pinbox preview list --json
```

Use the same registration for Main, with label `Main` and no PR. The dropdown includes existing
worktrees without a running preview as unavailable. Open the branch menu and use its refresh button to update the list.
Readiness checks require a matching worktree identity from the registered loopback Vite server;
redirects are not followed. If a worktree changes branch, register it again. The UI checks
readiness again before navigating. A missing route may show the destination app's normal 404.

Opening a PR and registering it does not prove the working files equal that PR's published HEAD;
agents should commit, push, and verify their checkout before requesting review. The tooltip
shows the current branch and commit. Unsaved feedback should be submitted before switching.

For a shared backend, offer independent review only for frontend changes compatible with the
current backend. Parallel backend watchers would overwrite each other's code. Separate backend
previews, data seeding, authentication, automatic process startup, and worktree cleanup are
outside this first version. Keep pins before removing a worktree: its `.pinbox/` holds the history.
