#!/bin/sh
# pinbox hook payload — UserPromptSubmit → `pinbox session inject --hook`.
# Canonical copy: the agent plugins copy this file byte-identical; `pinbox init`'s long-tail
# path installs it directly. Resolves `pinbox` from PATH; hook stdin passes through and
# stdout is the agents' {"hookSpecificOutput":…} injection contract (silent when there
# is nothing to inject).
if command -v pinbox >/dev/null 2>&1; then
  exec pinbox session inject --hook
fi
exec bunx @autono/pinbox session inject --hook
