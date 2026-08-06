#!/bin/sh
# pinbox hook payload — SessionStart → `pinbox session register --hook`.
# Canonical copy: the agent plugins copy this file byte-identical; `pinbox init`'s long-tail
# path installs it directly. Resolves `pinbox` from PATH (no ${CLAUDE_PLUGIN_ROOT} —
# that idiom belongs to the plugin copies); the agent's hook payload JSON on stdin
# passes straight through to the plumbing verb.
if command -v pinbox >/dev/null 2>&1; then
  exec pinbox session register --hook
fi
exec bunx @autono/pinbox session register --hook
