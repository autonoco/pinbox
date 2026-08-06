# Pinbox for Hermes — you're almost done

Two steps remain; neither can be done by the plugin system.

## 1. Put pinbox on PATH and initialize the project

The plugin shells out to the `pinbox` binary for everything — it has no bundled
runtime. Install pinbox (`bunx @autono/pinbox` works too), then in each project:

```sh
pinbox init
```

That creates `.pinbox/` project state, the gitignore entry, and the git hook.

## 2. Restart the gateway

```sh
hermes gateway restart
```

Hooks and tools register at gateway start; until the restart, nothing is wired.

## What you get

- Every turn, open pins are injected as compact markdown (`pre_llm_call`).
- Native tools: `pin_list`, `pin_reply`, `pin_resolve` — no MCP server needed.
- `/pinbox` slash command for a quick workspace orientation.
- The bundled skill is **not** listed in `<available_skills>` (Hermes excludes
  plugin skills) — the injected pointer tells the model to run
  `skill_view("pinbox:pinbox")`.
