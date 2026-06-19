# Contributing to Archer

The gates exist so that *anyone* — including an agent acting on a Proposal — can
contribute safely. Work with them, not around them.

## Workflow

1. Branch off `main` (`feat/…`, `fix/…`).
2. Make the change. The hooks help as you go:
   - **pre-commit** → gitleaks (secrets) + Biome/Ruff autofix on staged files.
   - **commit-msg** → [Conventional Commits](https://www.conventionalcommits.org)
     (`feat:`, `fix:`, `chore:`, `docs:`…). Required.
   - **pre-push** → typecheck + tests.
3. If you changed a **published package**, add a changeset: `pnpm changeset`.
4. Open a PR. CI must be green (`ci-ok`) and a code owner must approve.

## Commands

| Task | Command |
|---|---|
| Install + wire hooks | `pnpm install` |
| Lint / format | `pnpm lint` · `pnpm lint:fix` |
| Typecheck | `pnpm typecheck` |
| Test | `pnpm test` |
| Build | `pnpm build` |
| Regenerate DB types | `pnpm db:gen` |

## Changing the schema

The database is the contract. Add a migration under
`packages/db/supabase/migrations/`, then:

```sh
pnpm db:gen           # regenerates packages/db/src/database.types.ts
```

Commit both the migration and the regenerated types. CI's drift gate fails if they
disagree. Keep migrations safe (squawk lints them); prefer additive changes.

## Secrets

Never commit secrets. Real values live in Komodo (runtime) and GitHub Actions (CI);
`.env` is gitignored and gitleaks-guarded. Document new variables in `.env.example`.

## For agents

Same rules, enforced mechanically: branch (never push to `main`), Conventional
Commit, open a PR, let `ci-ok` + the `production` environment approval gate the
deploy. Link the originating Proposal/issue in the PR body.
