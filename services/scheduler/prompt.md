# Archer scheduled tick

This file is the prompt that the scheduler feeds to `claude -p` on every tick
(default: every 30 minutes). Edit it to change what Archer does when it wakes up.

The scheduler runs the command stored in its SQLite config; by default that command
is:

```sh
claude -p "@./services/scheduler/prompt.md"
```

The `@./services/scheduler/prompt.md` reference tells Claude Code to load this file's
contents as the prompt.

---

## Your task this tick

You are Archer's recurring heartbeat. On each run:

1. Briefly review what's changed since the last tick.
2. Do the smallest useful unit of work toward the current goal.
3. Summarise what you did in one or two sentences.

Replace this section with the real instructions you want Archer to follow.
