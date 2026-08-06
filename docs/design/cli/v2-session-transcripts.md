# Pinbox CLI v2 — session transcripts

**Date:** 2026-08-04 · **Status:** historical design artifact · **Scope:** the hidden
`session` verb (`register`, `list`) and the `summary` `sessions` line

Extends `v1-transcripts.md`; every decision there (mode selection, envelope, stdout/stderr
split, exit codes, hints) applies unchanged. This document covers only the session
surface: `session register|list` and the `summary` fact line it adds. `session inject|pending`
are hook plumbing whose stdout is the *agents'* injection contract
(`{"hookSpecificOutput":…}`, the shape Claude Code's hook API defines), not the
pinbox envelope; they are documented by their tests
(`packages/cli/src/commands/session.test.ts`), not transcribed here.

---

## Decisions this document encodes

1. **`session` is hidden.** It never appears in `pinbox --help`: hooks and the pinbox
   skill are the callers, not people. Like `serve`, it still has full help when asked.
2. **`--hook` switches contracts, `--json` does not mix in.** Under `--hook`, stdin is
   the agent's hook payload (`{session_id, cwd, hook_event_name, …}`) and stdout is the
   agent's injection shape — or *nothing*, for side-effect events (`register`) and empty
   gates (`pending` with zero pending; empty stdout must not hold the agent).
3. **Fingerprint over flags, flags over fingerprint.** In hook mode the agent name comes
   from env (`CLAUDECODE=1` → claude; Codex/Hermes markers likewise); `--agent`
   overrides; no fingerprint and no flag is `E_INVALID_INPUT` with the flag hint.
   Without `--hook`, both `--agent` and `--key` are required.
4. **`summary` gains one fact line** (`sessions` — count of not-ended agent sessions),
   placed with the other counts, before the cursor line. JSON `data` gains the additive
   `sessions` field.

---

## `pinbox session`

```
$ pinbox session --help
Usage: pinbox session [options] [command]

Hidden plumbing invoked by agent hooks: register agent sessions with the hub and pull pending pin
context. Not part of the human surface — the pinbox skill and the hook scripts in
packages/cli/hooks/ are the callers.

Options:
  -h, --help          display help for command

Commands:
  register [options]  register (upsert) an agent session
  list                list registered agent sessions
  inject [options]    pull open-pin context into the agent's next turn
  pending [options]   report pins awaiting delivery to this session
  help [command]      display help for command
```

---

## `pinbox session register`

### --help

```
$ pinbox session register --help
Usage: pinbox session register [options]

Register (upsert) an agent session with the hub. Fired by SessionStart hooks.

Options:
  --agent <name>  agent name (claude, codex, hermes, openclaw)
  --key <key>     agent session key
  --cwd <dir>     session working directory
  --hook          read the agent hook payload JSON from stdin; side-effect only
  --json          machine output
  -h, --help      display help for command
```

### Human

The session id is the fact (stdout); the confirmation is messaging (stderr).

```
$ pinbox session register --agent claude --key e2e-s1 --cwd /work/app
ses_fylw8li611
registered claude session e2e-s1
```

### JSON

`data` is the full `Session` — upsert by (agent, key): re-registering keeps the id,
bumps `lastSeenAt`, clears `endedAt`.

```
$ pinbox session register --agent claude --key e2e-s1 --cwd /work/app --json
{
  "ok": true,
  "data": {
    "id": "ses_fylw8li611",
    "agent": "claude",
    "key": "e2e-s1",
    "cwd": "/work/app",
    "registeredAt": "2026-08-04T18:14:03.409Z",
    "lastSeenAt": "2026-08-04T18:14:03.409Z"
  }
}
```

### Hook mode

`SessionStart` is side-effect only: nothing on stdout, exit 0.

```
$ echo '{"session_id":"e2e-s1","cwd":"/work/app","hook_event_name":"SessionStart"}' \
    | pinbox session register --hook
$ echo $?
0
```

### Error — no fingerprint, no flags

```
$ pinbox session register --json
{
  "ok": false,
  "error": {
    "code": "E_INVALID_INPUT",
    "message": "missing --agent and --key",
    "hint": "pass --agent <name> --key <key>, or --hook with the agent's hook payload on stdin"
  }
}
$ echo $?
2
```

---

## `pinbox session list`

### Human

One line per session: id, agent, key, state (`active` | `ended`). Columns space-aligned;
the count line goes to stderr.

```
$ pinbox session list
ses_fylw8li611  claude  e2e-s1  active
ses_2b9x0cmq4r  codex   e2e-s2  ended
2 session(s)
```

### JSON

```
$ pinbox session list --json
{
  "ok": true,
  "data": [
    {
      "id": "ses_fylw8li611",
      "agent": "claude",
      "key": "e2e-s1",
      "cwd": "/work/app",
      "registeredAt": "2026-08-04T18:14:03.409Z",
      "lastSeenAt": "2026-08-04T18:14:03.409Z"
    }
  ]
}
```

---

## `pinbox summary` — the `sessions` line

Additive only: the three v1 lines are unchanged, `sessions` (not-ended sessions) joins
the counts, the cursor stays last.

```
$ pinbox summary
open        3
resolved    12
sessions    1
last event  #42
```

```
$ pinbox summary --json
{
  "ok": true,
  "data": {
    "open": 3,
    "resolved": 12,
    "lastEventSeq": 42,
    "sessions": 1
  }
}
```
