#!/usr/bin/env bash
# Enforces the AGENTS.md file-size budget on source files:
#   >= 1000 lines -> deny the edit (hard cap; split the file first)
#   >=  500 lines -> allow, but inject a refactor-first reminder into context
# Wired as a PreToolUse hook (Edit|Write) in .claude/settings.json.
set -euo pipefail

input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")
[[ -z "$file" ]] && exit 0

# Source code only — prototypes/docs/config are exempt
case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac
case "$file" in
  */docs/*|*/.claude/*|*/node_modules/*|*/dist/*) exit 0 ;;
esac

existing=0
[[ -f "$file" ]] && existing=$(wc -l <"$file" | tr -d ' ')

# For Write, the incoming content's size is what matters
tool=$(jq -r '.tool_name // empty' <<<"$input")
count=$existing
if [[ "$tool" == "Write" ]]; then
  count=$(jq -r '.tool_input.content // ""' <<<"$input" | wc -l | tr -d ' ')
fi
[[ "$existing" -gt "$count" ]] && count=$existing

if [[ "$count" -ge 1000 ]]; then
  jq -n --arg r "BLOCKED by the AGENTS.md file-size budget: $file has/would have $count lines (hard cap: 1000). Do the preparatory refactoring first — split it into focused modules along responsibility boundaries — then retry the change in the right unit." \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
elif [[ "$count" -ge 500 ]]; then
  jq -n --arg c "$count" --arg f "$file" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("AGENTS.md file-size budget: " + $f + " is at " + $c + " lines (soft threshold: 500). Before appending more code here, design the split into focused modules and refactor first — only proceed with this specific edit if it is part of that split or genuinely trivial.")}}'
fi
exit 0
