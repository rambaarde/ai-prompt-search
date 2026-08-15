#!/bin/sh
# Build the fixture history the README demo is recorded against.
#
# The demo deliberately does not use a real prompt history. A real one carries
# client names, file paths, and whatever you happened to be debugging that
# week — none of which belongs in a GIF on a public README. So the recording
# runs the real `aps` over invented prompts, at a short neutral HOME, with no
# agent in the frame (an agent's banner prints the account it is signed in as).
#
#   sh docs/demo-fixture.sh && vhs docs/demo.tape
set -eu

HOME_DIR=${1:-/tmp/aps-demo}
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR/.claude" "$HOME_DIR/.codex/sessions" "$HOME_DIR/code/atlas"

BASE=$(( $(date +%s) - 259200 ))

# The recorded project path must be the *physical* one. On macOS /tmp is a
# symlink to /private/tmp, so a prompt filed under /tmp/... never matches a
# process whose cwd resolves to /private/tmp/..., and the demo opens on an
# empty panel with no hint as to why.
HERE=$(cd "$HOME_DIR/code/atlas" && pwd -P)

write_claude() {
  printf '{"display":%s,"timestamp":%s,"project":%s}\n' "\"$1\"" "$(( (BASE + $2) * 1000 ))" "\"$3\""
}

{
  write_claude "add a migration for the sessions table"      0    "$HERE"
  write_claude "why does the portal test flake on CI?"       900  "$HERE"
  write_claude "write the rollback for that migration"       1800 "$HERE"
  write_claude "add an index on sessions.expires_at"         2700 "$HERE"
  write_claude "run the portal tests and fix what breaks"    3600 "$HERE"
  write_claude "explain this stack trace"                    4200 "/code/beacon"
  write_claude "refactor the retry logic to use backoff"     5400 "$HERE"
  write_claude "generate the OpenAPI spec from the routes"   6300 "$HERE"
  write_claude "add a health check endpoint"                 7200 "/code/beacon"
  write_claude "why is the migration slow on large tables?"  8100 "$HERE"
} > "$HOME_DIR/.claude/history.jsonl"

write_codex() {
  printf '{"session_id":"s1","ts":%s,"text":%s}\n' "$(( BASE + $2 ))" "\"$1\""
}

{
  write_codex "deploy the api to staging"           1200
  write_codex "tail the staging logs for errors"    2400
  write_codex "roll back the last deploy"           3000
  write_codex "check the migration ran on staging"  5000
} > "$HOME_DIR/.codex/history.jsonl"

# Codex records no directory in its history, so the project comes from the
# session rollout — the same join the real reader performs.
printf '{"payload":{"id":"s1","cwd":"%s"}}\n' "$HERE" \
  > "$HOME_DIR/.codex/sessions/rollout-demo.jsonl"

echo "fixture ready at $HOME_DIR"
