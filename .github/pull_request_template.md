## What & why

<!-- One paragraph. If this PR is from an agent acting on a Proposal, link it. -->

Proposal / issue: #

## Checklist

- [ ] Conventional Commit title (`feat:`, `fix:`, `chore:` …)
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] If the schema changed: migration added **and** `pnpm db:gen` run (drift gate green)
- [ ] A changeset was added if a published package changed (`pnpm changeset`)
- [ ] No secrets in the diff (gitleaks will block them anyway)

## Risk / rollback

<!-- What could break, and how Komodo rolls back (previous :sha image). -->
