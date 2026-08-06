#!/bin/sh
# pinbox hook payload — Stop → `pinbox session pending --hook`.
# Canonical copy: the agent plugins copy this file byte-identical; `pinbox init`'s long-tail
# path installs it directly. Resolves `pinbox` from PATH; hook stdin passes through.
# Emits the hold context only while pending rows exist — empty stdout (zero pending)
# must not hold the agent.
if command -v pinbox >/dev/null 2>&1; then
  exec pinbox session pending --hook
fi
exec bunx @autono/pinbox session pending --hook
