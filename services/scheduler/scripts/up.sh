#!/usr/bin/env bash
#
# Activate the Archer scheduler in an ISOLATED git worktree, so its autonomous
# git operations (branch / commit / PR) never disturb your primary checkout.
#
# Idempotent: creates the worktree on first run, then just (re)starts the daemon.
# Run from the repo root:  pnpm scheduler
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
WORKTREE="${ARCHER_SCHEDULER_WORKTREE:-$ROOT/../Archer-agent}"
BRANCH="scheduler-agent"
CMD='claude -p "@./services/scheduler/prompt.md" --dangerously-skip-permissions'
LOG_REL="services/scheduler/scheduler.log"

# 1. Ensure the isolated worktree exists AND is at the latest origin/main, so a
#    (re)start always picks up merged prompt/code changes (the daemon reads
#    prompt.md from this checkout at process start). We only refresh when no run
#    is in flight, so we never move HEAD out from under a live agent run.
if [ ! -d "$WORKTREE" ]; then
  echo "→ creating isolated worktree at $WORKTREE (off origin/main)…"
  git -C "$ROOT" fetch origin
  git -C "$ROOT" worktree add -B "$BRANCH" "$WORKTREE" origin/main
elif ! pgrep -f "scheduler/dist/index.js" >/dev/null; then
  echo "→ refreshing worktree to origin/main (no run in flight)…"
  git -C "$WORKTREE" fetch origin --quiet
  git -C "$WORKTREE" checkout -f -B "$BRANCH" origin/main
fi

cd "$WORKTREE"

# 2. Build (installs deps + compiles better-sqlite3 + tsc) — fast on later runs.
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @archer/scheduler build >/dev/null

# 3. Configure the schedule (idempotent): 15 min, autonomous, all tools.
node services/scheduler/dist/cli.js set-command "$CMD" >/dev/null
node services/scheduler/dist/cli.js set-interval 15 >/dev/null
node services/scheduler/dist/cli.js enable >/dev/null

# 4. Start the daemon detached, unless one is already running.
if pgrep -f "scheduler/dist/index.js" >/dev/null; then
  echo "✓ scheduler already running (pid $(pgrep -f 'scheduler/dist/index.js' | tr '\n' ' '))"
else
  nohup node services/scheduler/dist/index.js > "$WORKTREE/$LOG_REL" 2>&1 &
  echo "✓ scheduler started (pid $!) in $WORKTREE"
fi

echo "  worktree : $WORKTREE"
echo "  command  : $CMD"
echo "  log      : $WORKTREE/$LOG_REL   (tail -f to watch ticks)"
echo "  config   : node services/scheduler/dist/cli.js status   (run from $WORKTREE)"
