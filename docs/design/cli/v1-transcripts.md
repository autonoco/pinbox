# Pinbox CLI v1 — terminal transcripts

**Date:** 2026-08-03 · **Status:** historical design artifact · **Scope:** the first CLI verb set

This is the CLI UX design artifact — literal terminal transcripts, the way a GUI design doc
would be mockups. Every transcript below is the exact output the implementation had to produce.
Sources of truth: clig.dev and the shipped schema (`packages/core/src/schema.ts`) —
every JSON example uses the real field names. For the surface as shipped, see
`docs/cli/commands.mdx`; this file is a historical design artifact and has drifted.

The verb set at the time this was written: `summary`, `list`, `show`, `reply`, `resolve`,
`export`, `doctor`, and the hidden `serve`. No `init`, no `link`, no `--search`, no
sessions — those landed later and do not appear in any help text below (the rule was:
never document an unshipped command).

**Amendment — `pinbox pin`.** One verb was added to this document after the fact: `pin`,
which creates a pin from the terminal (§pin). It lives here because it changes a contract
this document sets — it is what forced schema v1 to be widened so that `target` and `env`
are optional. The `--help` block below shows it.

---

## Decisions this document encodes

1. **Mode selection.** `--json` or a non-TTY stdout selects JSON mode; a TTY without the
   flag selects human mode. Most-explicit wins: `--json` on a TTY still emits JSON.
   `pinbox export` is the one exception — its stdout *is* the artifact (see §export).
2. **The envelope.** JSON mode always prints exactly one JSON document to stdout:
   `{"ok":true,"data":…}` or `{"ok":false,"error":{"code":…,"message":…,"hint":…}}`.
   Nothing else ever reaches stdout in JSON mode. The envelope is pretty-printed with
   2-space indent — one parseable document per invocation, readable when a human is
   debugging an agent's transcript. Machine output is a versioned contract.
3. **stdout is data, stderr is messaging.** In human mode, facts go to stdout (one line
   per fact, greppable, no decorative headers); counts, confirmations-of-side-effect and
   errors go to stderr. `pinbox list | grep open` never matches a footer.
4. **Exit codes are part of the contract**, mapped 1:1 from error codes:

   | exit | error code | meaning |
   |---|---|---|
   | 0 | — | success |
   | 1 | `E_INTERNAL` | unexpected failure (also: `doctor` found a broken capability) |
   | 2 | `E_INVALID_INPUT` | bad flag, bad argument, bad body |
   | 3 | `E_NOT_FOUND` | no such pin / no such resource |
   | 4 | `E_CONFLICT` | e.g. resolving an already-resolved pin |
   | 5 | `E_HUB_UNREACHABLE` | hub absent and could not be spawned |

5. **Every error carries a hint.** The `hint` field (JSON) / second stderr line (human)
   names the next command to run, not just what went wrong.
6. **Ids are exact.** Only full pin ids are accepted (`pin_` + 10 base36). No prefix
   matching yet — a prefix is `E_NOT_FOUND`, and the hint says so.
7. **The hub is invisible.** Every verb auto-spawns the hub on first contact. No
   transcript below contains a "starting hub…" line in human mode and no extra field in
   JSON mode; the plumbing is silent unless it fails (`E_HUB_UNREACHABLE`).
8. **Human timestamps are relative** (`2m ago`); JSON timestamps are the stored ISO
   strings, verbatim. Human output may color status words on a TTY; color never carries
   meaning that the text alone does not.

---

## `pinbox --help`

```
$ pinbox --help
Usage: pinbox [options] [command]

CLI-first feedback loop: pins dropped on a live app, fixed and resolved by agents.

Options:
  -V, --version                 output the version number
  --json                        machine output: {"ok":true,"data":…} envelope
  -h, --help                    display help for command

Commands:
  pin [options] <text>          create a pin from the terminal
  summary                       counts and the event cursor, in one call
  list [options]                list pins, newest first
  show <id>                     one pin with its full thread
  reply [options] <id> <text>   add a thread message to a pin
  resolve [options] <id>        mark a pin resolved
  export [options]              write pins to stdout as markdown or JSON
  doctor                        probe this machine's capabilities
  help [command]                display help for command
```

`serve` is registered but hidden: it is plumbing the daemon spawns, not a verb people
type. It still has help (see §serve).

```
$ pinbox --version
0.0.0
```

---

## The TTY / non-TTY auto-switch (shown once)

Same command, no flags changed — only where stdout points:

```
$ pinbox summary
open        3
resolved    12
last event  #42
```

```
$ pinbox summary | cat
{
  "ok": true,
  "data": {
    "open": 3,
    "resolved": 12,
    "lastEventSeq": 42
  }
}
```

Piping, redirecting, or running under an agent harness all mean a non-TTY stdout, so
agents get the contract without remembering a flag. `--json` forces the same output on
a TTY. This switch applies to every verb below and is not repeated per section.

---

## `pinbox pin <text>`

Creating a pin without a browser. Until this verb, only the toolbar (or raw HTTP)
could create one — a CLI-first product you could not use from a CLI.

**The contract decision this verb forced, and how it was resolved.** `PinInputSchema`
required `target` (url, selector, tag, rect, fixed) and `env` (viewport, browser, os,
colorScheme). A terminal has none of them. Synthesizing `browser: "cli"` and
`viewport: {w:0,h:0,dpr:1}` would write *lies* into a versioned contract that agents
read back as fact, so schema v1 was **widened instead of bumped**: those fields became
optional (`packages/core/src/schema.ts`, §"widened in place"). Relaxing required to
optional is backwards-compatible both ways — every pin ever written still validates,
and the toolbar keeps sending the full shape — so `schemaVersion` stays **1**.

A terminal pin therefore carries only what is true:

| field | where it comes from |
|---|---|
| `text` | what you typed |
| `target.source` | `--file <path[:line]>`, validated to exist, stored repo-relative, `via: "none"` |
| `target.url` / `target.selector` | `--url` / `--selector`, when the pin is about a web surface |
| `author` | git config `user.name` / `user.email`, falling back to `$USER` |
| `env` | nothing from the terminal — the hub stamps `branch`/`commit` from git, as it does for every pin |

There is no flag to hand-write a viewport, a rect, or a browser. Absence is the
honest encoding of "not measured", and every reader (`list`, `show`, `export`) prints
a fact only when it exists.

### --help

```
$ pinbox pin --help
Usage: pinbox pin [options] <text>

Create a pin from the terminal. No browser is involved, so nothing about one is recorded: anchor the
pin to a source location with --file, or to a web surface with --url.

Arguments:
  text                  what needs to change, in your words

Options:
  --file <path[:line]>  anchor to a source location (recorded repo-relative)
  --url <url>           the web surface this pin is about
  --selector <sel>      CSS selector on that surface (needs --url)
  --json                machine output
  -h, --help            display help for command
```

### Human

The created pin id is the fact (stdout); the confirmation is messaging (stderr) —
the same split as `reply`, so `pinbox pin … | xargs pinbox show` works.

```
$ pinbox pin "the footer overlaps on mobile" --file src/app.tsx:42
pin_7x2m9k4d1e
pinned to src/app.tsx:42
```

With no anchor at all — a note about the product, not about a place:

```
$ pinbox pin "make the onboarding shorter"
pin_3n8v5c2z0q
pinned
```

About a web surface, from a terminal that never opened it (so a URL and a selector,
and still no rect):

```
$ pinbox pin "pricing page 404s" --url https://example.com/pricing --selector "a.pricing"
pin_5r4t3y2u1i
pinned to https://example.com/pricing
```

Terminal pins read back through the existing verbs. The locus column takes the most
specific place a pin names — selector, else source anchor, else URL — and `—` when a
pin names none:

```
$ pinbox list
pin_ab12cd34ef  open  2m ago   main > button.cta  button is cut off
pin_7x2m9k4d1e  open  1m ago   src/app.tsx:42     the footer overlaps on mobile
pin_3n8v5c2z0q  open  1m ago   —                  make the onboarding shorter
3 pins (3 open)
```

`show` prints one line per fact **that exists** — no `url`, `rect` or `env` line for a
pin that has none, and never the string `undefined`:

```
$ pinbox show pin_7x2m9k4d1e
pin_7x2m9k4d1e  open  note
text      the footer overlaps on mobile
source    src/app.tsx:42
git       main @ 9c2f1b8
author    bobak@autono.co
created   2026-08-03T17:13:45.120Z (1m ago)
```

`export` obeys the same rule at every detail level (§export shows the browser case):

````
$ pinbox export --detail forensic --status open
- [open] src/app.tsx:42 — the footer overlaps on mobile (pin_7x2m9k4d1e)
  - source: src/app.tsx:42

  ```json
  {
    "env": {
      "branch": "main",
      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
    }
  }
  ```
- [open] make the onboarding shorter (pin_3n8v5c2z0q)

  ```json
  {
    "env": {
      "branch": "main",
      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
    }
  }
  ```
````

The unanchored pin's headline carries no locus and no ` — ` separator; its fence
holds only the git stamp. A pin with *nothing* to record — no context, and no git to
stamp — gets no fence at all rather than an empty one.

### JSON

`data` is the created `Pin` — the same shape `resolve` returns. Note what is *absent*:
no `env.viewport`, no `target.rect`. Absent, not zeroed.

```
$ pinbox pin "the footer overlaps on mobile" --file src/app.tsx:42 --json
{
  "ok": true,
  "data": {
    "text": "the footer overlaps on mobile",
    "kind": "note",
    "target": {
      "source": {
        "file": "src/app.tsx",
        "line": 42,
        "via": "none"
      }
    },
    "env": {
      "branch": "main",
      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
    },
    "author": {
      "userId": "bobak@autono.co",
      "name": "Bobak Emamian",
      "email": "bobak@autono.co"
    },
    "id": "pin_7x2m9k4d1e",
    "schemaVersion": 1,
    "status": "open",
    "createdAt": "2026-08-03T17:13:45.120Z"
  }
}
```

### Error — `--file` points at nothing

A pin anchored to a path that does not exist is worse than an unanchored pin: the
agent goes looking and finds nothing. So the path is validated before the pin is
created, and nothing is written.

```
$ pinbox pin "the footer overlaps on mobile" --file src/nope.tsx:42
pinbox: no such file: "src/nope.tsx"
--file takes a path that exists, optionally with :line
$ echo $?
2
```

```
$ pinbox pin "the footer overlaps on mobile" --file src/nope.tsx:42 --json
{
  "ok": false,
  "error": {
    "code": "E_INVALID_INPUT",
    "message": "no such file: \"src/nope.tsx\"",
    "hint": "--file takes a path that exists, optionally with :line"
  }
}
```

### Error — a selector with no page

```
$ pinbox pin "pricing page 404s" --selector "a.pricing"
pinbox: --selector needs --url (a selector without a page is not a target)
run `pinbox pin --help` for usage
$ echo $?
2
```

Empty text is `E_INVALID_INPUT` too, hinted the way `reply` hints it
(`quote the text: pinbox pin "your text"`).

---

## `pinbox summary`

The one-call orientation: an agent learns the whole workspace state without running
`list` first.

### --help

```
$ pinbox summary --help
Usage: pinbox summary [options]

Counts and the event cursor, in one call.

Options:
  --json      machine output
  -h, --help  display help for command
```

### Human

```
$ pinbox summary
open        3
resolved    12
last event  #42
```

### JSON

```
$ pinbox summary --json
{
  "ok": true,
  "data": {
    "open": 3,
    "resolved": 12,
    "lastEventSeq": 42
  }
}
```

### Error — hub unreachable

The spawn path failed (port exhaustion, unwritable state dir, broken install). Human:

```
$ pinbox summary
pinbox: cannot reach the hub and could not start one
run `pinbox doctor` to find out why
$ echo $?
5
```

JSON (still stdout — the envelope is the contract even for failures):

```
$ pinbox summary --json
{
  "ok": false,
  "error": {
    "code": "E_HUB_UNREACHABLE",
    "message": "cannot reach the hub and could not start one",
    "hint": "run `pinbox doctor` to find out why"
  }
}
$ echo $?
5
```

---

## `pinbox list`

### --help

```
$ pinbox list --help
Usage: pinbox list [options]

List pins, newest first.

Options:
  --status <status>  filter: open or resolved (default: all)
  --json             machine output
  -h, --help         display help for command
```

### Human

One line per pin: id, status, age, selector, comment. Columns are space-aligned and
greppable; the count line goes to stderr so pipes stay clean.

```
$ pinbox list
pin_ab12cd34ef  open      2m ago   main > button.cta  button is cut off
pin_9k3j2h1g0f  open      1h ago   header img.logo    logo is blurry on retina
pin_q8w7e6r5t4  resolved  3h ago   footer a.terms     terms link 404s
3 pins (2 open, 1 resolved)
```

Filtered:

```
$ pinbox list --status open
pin_ab12cd34ef  open  2m ago   main > button.cta  button is cut off
pin_9k3j2h1g0f  open  1h ago   header img.logo    logo is blurry on retina
2 pins (2 open)
```

Empty (stdout is empty — the count line is stderr):

```
$ pinbox list --status resolved
0 pins
$ pinbox list --status resolved 2>/dev/null | wc -l
       0
```

### JSON

`data` is the array of full pins — the exact `Pin` schema, nothing summarized away.

```
$ pinbox list --status open --json
{
  "ok": true,
  "data": [
    {
      "id": "pin_ab12cd34ef",
      "schemaVersion": 1,
      "text": "button is cut off",
      "kind": "note",
      "status": "open",
      "target": {
        "url": "http://localhost:3000/",
        "selector": "main > button.cta",
        "tag": "button",
        "rect": { "x": 120, "y": 480, "width": 200, "height": 48 },
        "fixed": false,
        "context": { "nearbyText": "Get started free" }
      },
      "env": {
        "viewport": { "w": 1440, "h": 900, "dpr": 2 },
        "browser": "Chrome 130",
        "os": "macOS",
        "colorScheme": "light",
        "branch": "main",
        "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
      },
      "author": { "userId": "bobak" },
      "createdAt": "2026-08-03T17:12:45.120Z"
    },
    {
      "id": "pin_9k3j2h1g0f",
      "schemaVersion": 1,
      "text": "logo is blurry on retina",
      "kind": "note",
      "status": "open",
      "target": {
        "url": "http://localhost:3000/",
        "selector": "header img.logo",
        "tag": "img",
        "rect": { "x": 24, "y": 12, "width": 96, "height": 32 },
        "fixed": true
      },
      "env": {
        "viewport": { "w": 1440, "h": 900, "dpr": 2 },
        "browser": "Chrome 130",
        "os": "macOS",
        "colorScheme": "light",
        "branch": "main",
        "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
      },
      "author": { "userId": "bobak" },
      "createdAt": "2026-08-03T16:09:02.881Z"
    }
  ]
}
```

Empty is `"data": []`, exit 0 — an empty list is a successful answer, not an error.

### Error — bad flag value

```
$ pinbox list --status closed
pinbox: invalid --status: "closed" (expected open or resolved)
run `pinbox list --help` for usage
$ echo $?
2
```

```
$ pinbox list --status closed --json
{
  "ok": false,
  "error": {
    "code": "E_INVALID_INPUT",
    "message": "invalid --status: \"closed\" (expected open or resolved)",
    "hint": "run `pinbox list --help` for usage"
  }
}
```

---

## `pinbox show <id>`

The pin plus its full thread — everything an agent needs to act on one pin.

### --help

```
$ pinbox show --help
Usage: pinbox show [options] <id>

One pin with its full thread.

Arguments:
  id          pin id (pin_xxxxxxxxxx)

Options:
  --json      machine output
  -h, --help  display help for command
```

### Human

One line per fact; the thread renders as `role  age  text` lines under a blank-line
separator. Absent optional fields print nothing (no `source: -` noise).

```
$ pinbox show pin_ab12cd34ef
pin_ab12cd34ef  open  note
text      button is cut off
target    main > button.cta  <button>
url       http://localhost:3000/
rect      120,480 200x48
nearby    "Get started free"
env       1440x900@2x  Chrome 130  macOS  light
git       main @ 9c2f1b8
author    bobak
created   2026-08-03T17:12:45.120Z (2m ago)

human  2m ago  button is cut off
agent  1m ago  Found it — the CTA overflows its flex parent at <=1280px. Fixing.
```

A resolved pin adds the resolution facts:

```
$ pinbox show pin_q8w7e6r5t4
pin_q8w7e6r5t4  resolved  note
text      terms link 404s
target    footer a.terms  <a>
url       http://localhost:3000/
rect      310,2044 64x18
env       1440x900@2x  Chrome 130  macOS  light
git       main @ 9c2f1b8
author    bobak
created   2026-08-03T14:20:11.410Z (3h ago)
resolved  by agent, 2h ago — routed /terms to the new legal page

human  3h ago  terms link 404s
agent  2h ago  The route moved in the nav refactor. Restoring redirect.
```

### JSON

`data` is `{ "pin": Pin, "thread": ThreadMessage[] }` — the two resources `show` joins.

```
$ pinbox show pin_q8w7e6r5t4 --json
{
  "ok": true,
  "data": {
    "pin": {
      "id": "pin_q8w7e6r5t4",
      "schemaVersion": 1,
      "text": "terms link 404s",
      "kind": "note",
      "status": "resolved",
      "target": {
        "url": "http://localhost:3000/",
        "selector": "footer a.terms",
        "tag": "a",
        "rect": { "x": 310, "y": 2044, "width": 64, "height": 18 },
        "fixed": false
      },
      "env": {
        "viewport": { "w": 1440, "h": 900, "dpr": 2 },
        "browser": "Chrome 130",
        "os": "macOS",
        "colorScheme": "light",
        "branch": "main",
        "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
      },
      "author": { "userId": "bobak" },
      "resolution": {
        "by": "agent",
        "note": "routed /terms to the new legal page",
        "at": "2026-08-03T15:03:27.940Z"
      },
      "createdAt": "2026-08-03T14:20:11.410Z"
    },
    "thread": [
      {
        "id": "msg_7f2k9d3m1p",
        "pinId": "pin_q8w7e6r5t4",
        "role": "human",
        "text": "terms link 404s",
        "at": "2026-08-03T14:20:11.410Z"
      },
      {
        "id": "msg_2c8n4x6v0b",
        "pinId": "pin_q8w7e6r5t4",
        "role": "agent",
        "text": "The route moved in the nav refactor. Restoring redirect.",
        "at": "2026-08-03T14:58:40.005Z"
      }
    ]
  }
}
```

### Error — unknown id

```
$ pinbox show pin_0000000000
pinbox: no pin with id pin_0000000000
run `pinbox list` to see valid ids (full ids only — prefixes don't match)
$ echo $?
3
```

```
$ pinbox show pin_0000000000 --json
{
  "ok": false,
  "error": {
    "code": "E_NOT_FOUND",
    "message": "no pin with id pin_0000000000",
    "hint": "run `pinbox list` to see valid ids (full ids only — prefixes don't match)"
  }
}
```

---

## `pinbox reply <id> <text>`

### --help

```
$ pinbox reply --help
Usage: pinbox reply [options] <id> <text>

Add a thread message to a pin. Replying never resolves.

Arguments:
  id          pin id (pin_xxxxxxxxxx)
  text        the message

Options:
  --as <role>  author role: human or agent (default: "human")
  --json       machine output
  -h, --help   display help for command
```

### Human

The created message id is the fact (stdout); the confirmation is messaging (stderr).

```
$ pinbox reply pin_ab12cd34ef "does this also happen at 1024px?"
msg_5t9y7u3i1o
replied to pin_ab12cd34ef as human
```

Agents replying identify themselves:

```
$ pinbox reply pin_ab12cd34ef "Yes — same overflow at 1024. One fix covers both." --as agent
msg_8h4g6f2d0s
replied to pin_ab12cd34ef as agent
```

### JSON

`data` is the created `ThreadMessage`, verbatim.

```
$ pinbox reply pin_ab12cd34ef "does this also happen at 1024px?" --json
{
  "ok": true,
  "data": {
    "id": "msg_5t9y7u3i1o",
    "pinId": "pin_ab12cd34ef",
    "role": "human",
    "text": "does this also happen at 1024px?",
    "at": "2026-08-03T17:16:03.552Z"
  }
}
```

### Error — empty text

```
$ pinbox reply pin_ab12cd34ef ""
pinbox: reply text must not be empty
quote the message: pinbox reply <id> "your text"
$ echo $?
2
```

```
$ pinbox reply pin_ab12cd34ef "" --json
{
  "ok": false,
  "error": {
    "code": "E_INVALID_INPUT",
    "message": "reply text must not be empty",
    "hint": "quote the message: pinbox reply <id> \"your text\""
  }
}
```

(Unknown id behaves exactly as in §show: `E_NOT_FOUND`, exit 3.)

---

## `pinbox resolve <id>`

### --help

```
$ pinbox resolve --help
Usage: pinbox resolve [options] <id>

Mark a pin resolved.

Arguments:
  id           pin id (pin_xxxxxxxxxx)

Options:
  --note <text>  resolution note (e.g. what changed, or why it won't)
  --as <role>    resolver: human or agent (default: "human")
  --json         machine output
  -h, --help     display help for command
```

### Human

```
$ pinbox resolve pin_ab12cd34ef --note "flex-shrink on the CTA; verified at 1024 and 1280" --as agent
pin_ab12cd34ef resolved
by agent — flex-shrink on the CTA; verified at 1024 and 1280
```

A no-commit "won't fix" is the same verb with a note and no commit — there is no
separate state:

```
$ pinbox resolve pin_9k3j2h1g0f --note "intended: logo ships as 1x until the brand refresh"
pin_9k3j2h1g0f resolved
by human — intended: logo ships as 1x until the brand refresh
```

### JSON

`data` is the full updated `Pin` — status flipped, `resolution` present.

```
$ pinbox resolve pin_ab12cd34ef --note "flex-shrink on the CTA; verified at 1024 and 1280" --as agent --json
{
  "ok": true,
  "data": {
    "id": "pin_ab12cd34ef",
    "schemaVersion": 1,
    "text": "button is cut off",
    "kind": "note",
    "status": "resolved",
    "target": {
      "url": "http://localhost:3000/",
      "selector": "main > button.cta",
      "tag": "button",
      "rect": { "x": 120, "y": 480, "width": 200, "height": 48 },
      "fixed": false,
      "context": { "nearbyText": "Get started free" }
    },
    "env": {
      "viewport": { "w": 1440, "h": 900, "dpr": 2 },
      "browser": "Chrome 130",
      "os": "macOS",
      "colorScheme": "light",
      "branch": "main",
      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
    },
    "author": { "userId": "bobak" },
    "resolution": {
      "by": "agent",
      "note": "flex-shrink on the CTA; verified at 1024 and 1280",
      "at": "2026-08-03T17:31:09.284Z"
    },
    "createdAt": "2026-08-03T17:12:45.120Z"
  }
}
```

### Error — already resolved

Resolve is once-only; the second attempt is a conflict, not a no-op — an agent must
notice it raced another resolver.

```
$ pinbox resolve pin_ab12cd34ef
pinbox: pin_ab12cd34ef is already resolved
run `pinbox show pin_ab12cd34ef` to see who resolved it and why
$ echo $?
4
```

```
$ pinbox resolve pin_ab12cd34ef --json
{
  "ok": false,
  "error": {
    "code": "E_CONFLICT",
    "message": "pin_ab12cd34ef is already resolved",
    "hint": "run `pinbox show pin_ab12cd34ef` to see who resolved it and why"
  }
}
```

---

## `pinbox export`

**The exception to the auto-switch.** `export` exists to produce a document on stdout
for piping and pasting; wrapping markdown in a JSON envelope because stdout is a pipe
would defeat the command. So: `--format` alone decides what stdout carries. `--format md`
(the default) writes raw markdown even when piped; `--format json` writes the envelope
with the pin array (`--json` is an alias for it). Explicit beats implicit.

### --help

```
$ pinbox export --help
Usage: pinbox export [options]

Write pins to stdout as markdown or JSON.

Options:
  --format <format>  md or json (default: "md")
  --detail <level>   compact, standard, or forensic (default: "standard")
  --status <status>  filter: open or resolved (default: all)
  --json             same as --format json
  -h, --help         display help for command
```

### Markdown, detail dial

The detail dial is the token-budget control. `compact` — one line per pin:

```
$ pinbox export --detail compact --status open
- [open] main > button.cta — button is cut off (pin_ab12cd34ef)
- [open] header img.logo — logo is blurry on retina (pin_9k3j2h1g0f)
```

`standard` (the default) adds indented context lines — URL, source file (when a
targeting adapter captured one), rect, nearby text — each line present only when the
fact exists:

```
$ pinbox export --status open
- [open] main > button.cta — button is cut off (pin_ab12cd34ef)
  - url: http://localhost:3000/
  - rect: 120,480 200x48
  - nearby: "Get started free"
- [open] header img.logo — logo is blurry on retina (pin_9k3j2h1g0f)
  - url: http://localhost:3000/
  - rect: 24,12 96x32
```

`forensic` adds a fenced JSON block per pin carrying `target.context` and `env`:

````
$ pinbox export --detail forensic --status open
- [open] main > button.cta — button is cut off (pin_ab12cd34ef)
  - url: http://localhost:3000/
  - rect: 120,480 200x48
  - nearby: "Get started free"

  ```json
  {
    "context": { "nearbyText": "Get started free" },
    "env": {
      "viewport": { "w": 1440, "h": 900, "dpr": 2 },
      "browser": "Chrome 130",
      "os": "macOS",
      "colorScheme": "light",
      "branch": "main",
      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
    }
  }
  ```
- [open] header img.logo — logo is blurry on retina (pin_9k3j2h1g0f)
  - url: http://localhost:3000/
  - rect: 24,12 96x32

  ```json
  {
    "env": {
      "viewport": { "w": 1440, "h": 900, "dpr": 2 },
      "browser": "Chrome 130",
      "os": "macOS",
      "colorScheme": "light",
      "branch": "main",
      "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
    }
  }
  ```
````

Piping stays markdown — this is the zero-setup fallback ("copy pins into any chat"):

```
$ pinbox export --detail compact > pins.md && head -1 pins.md
- [open] main > button.cta — button is cut off (pin_ab12cd34ef)
```

### JSON

Identical envelope-and-`Pin[]` shape as `pinbox list --json` (one contract, not two):

```
$ pinbox export --format json --status resolved
{
  "ok": true,
  "data": [
    {
      "id": "pin_q8w7e6r5t4",
      "schemaVersion": 1,
      "text": "terms link 404s",
      "kind": "note",
      "status": "resolved",
      "target": {
        "url": "http://localhost:3000/",
        "selector": "footer a.terms",
        "tag": "a",
        "rect": { "x": 310, "y": 2044, "width": 64, "height": 18 },
        "fixed": false
      },
      "env": {
        "viewport": { "w": 1440, "h": 900, "dpr": 2 },
        "browser": "Chrome 130",
        "os": "macOS",
        "colorScheme": "light",
        "branch": "main",
        "commit": "9c2f1b8d0e4a7c6b5a4d3e2f1a0b9c8d7e6f5a4b"
      },
      "author": { "userId": "bobak" },
      "resolution": {
        "by": "agent",
        "note": "routed /terms to the new legal page",
        "at": "2026-08-03T15:03:27.940Z"
      },
      "createdAt": "2026-08-03T14:20:11.410Z"
    }
  ]
}
```

### Error — bad detail level

```
$ pinbox export --detail full
pinbox: invalid --detail: "full" (expected compact, standard, or forensic)
run `pinbox export --help` for usage
$ echo $?
2
```

```
$ pinbox export --detail full --format json
{
  "ok": false,
  "error": {
    "code": "E_INVALID_INPUT",
    "message": "invalid --detail: \"full\" (expected compact, standard, or forensic)",
    "hint": "run `pinbox export --help` for usage"
  }
}
```

---

## `pinbox doctor`

A capability probe, not a version table: each check *does the thing* and reports what
happened. The checks: `sqlite`, `fts5`, `state-dir`, `db-writable`, `hub`, `agents`.
`agents` is informational (always ok); any other check failing exits 1.

### --help

```
$ pinbox doctor --help
Usage: pinbox doctor [options]

Probe this machine's capabilities: storage, state dir, hub spawn, agents on PATH.

Options:
  --json      machine output
  -h, --help  display help for command
```

### Human — healthy

```
$ pinbox doctor
ok  sqlite       created and read a table in :memory:
ok  fts5         MATCH query answered on a virtual table
ok  state-dir    ~/.local/state/pinbox/3f8a2c19d04e writable, mode 0700
ok  db-writable  .pinbox/pinbox.db opens for writing
ok  hub          spawned, healthy at http://127.0.0.1:52341 (schemaVersion 1)
ok  agents       found: claude, codex
6 checks, all ok
$ echo $?
0
```

### Human — a capability is broken

Doctor is where `E_HUB_UNREACHABLE` hints land, so its diagnosis names the cause, not
the symptom:

```
$ pinbox doctor
ok  sqlite       created and read a table in :memory:
ok  fts5         MATCH query answered on a virtual table
no  state-dir    /root/.local/state/pinbox/3f8a2c19d04e: EACCES creating directory
ok  db-writable  .pinbox/pinbox.db opens for writing
no  hub          spawn failed: cannot write hub.json to state dir
ok  agents       found: claude
6 checks, 2 failing
$ echo $?
1
```

The check lines are stdout (they are the data); the count line is stderr.

### JSON

The envelope stays `ok: true` when doctor *ran* — the findings live in `data`, and the
exit code carries the verdict. An agent branches on `checks[].ok`, not on parse failure.

```
$ pinbox doctor --json
{
  "ok": true,
  "data": {
    "checks": [
      { "name": "sqlite", "ok": true, "detail": "created and read a table in :memory:" },
      { "name": "fts5", "ok": true, "detail": "MATCH query answered on a virtual table" },
      {
        "name": "state-dir",
        "ok": false,
        "detail": "/root/.local/state/pinbox/3f8a2c19d04e: EACCES creating directory"
      },
      { "name": "db-writable", "ok": true, "detail": ".pinbox/pinbox.db opens for writing" },
      { "name": "hub", "ok": false, "detail": "spawn failed: cannot write hub.json to state dir" },
      { "name": "agents", "ok": true, "detail": "found: claude" }
    ]
  }
}
$ echo $?
1
```

### Error — unknown option

Doctor itself can still fail the contract way (bad invocation, internal fault):

```
$ pinbox doctor --fix
pinbox: unknown option '--fix'
run `pinbox doctor --help` for usage
$ echo $?
2
```

```
$ pinbox doctor --fix --json
{
  "ok": false,
  "error": {
    "code": "E_INVALID_INPUT",
    "message": "unknown option '--fix'",
    "hint": "run `pinbox doctor --help` for usage"
  }
}
```

---

## `pinbox serve` (hidden — help only)

Users never type it; the daemon lifecycle spawns it detached. It stays invisible in
`pinbox --help`, but `pinbox serve --help` works, because a hidden command with hidden
help is a debugging dead end. This document describes no other interaction with it.

```
$ pinbox serve --help
Usage: pinbox serve [options]

Run the hub in the foreground. You normally never run this: every pinbox command
starts the hub on demand and it exits when idle. Useful for debugging the daemon.

Options:
  --project <dir>  project directory to serve (default: cwd)
  -h, --help       display help for command

Environment:
  PINBOX_IDLE_MS   idle shutdown in milliseconds (default: 1800000)

The hub binds 127.0.0.1 on an ephemeral port. The port is written to
.pinbox/server.json; the pid and bearer token live in the XDG state dir (0600).
Secrets never sit in the repo.
```

---

## Cross-cutting reference

Error code → exit code, and the command surfaces where each can occur:

| code | exit | surfaces |
|---|---|---|
| `E_INVALID_INPUT` | 2 | every verb (flags/args); reply (empty text); pin (missing `--file` path, `--selector` without `--url`, empty text) |
| `E_NOT_FOUND` | 3 | show, reply, resolve (unknown id) |
| `E_CONFLICT` | 4 | resolve (already resolved) |
| `E_HUB_UNREACHABLE` | 5 | every verb that contacts the hub (all but `--help`/`--version`) |
| `E_INTERNAL` | 1 | any verb (unexpected); doctor's exit when a required check fails |

Invariants every transcript above obeys:

- JSON mode: exactly one JSON document on stdout, nothing on stderr, envelope always.
- Human mode: facts on stdout, counts/confirmations/errors on stderr.
- Every failure names a next step in its hint.
- No transcript shows a verb, flag, or field that did not ship.
