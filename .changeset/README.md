# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).

When you make a change to a published package, run `pnpm changeset` and describe it.
On merge to `main`, the **Version Packages** PR collects these into version bumps and
changelog entries; the version it stamps becomes the GHCR image tag Komodo deploys.

See the [common questions](https://github.com/changesets/changesets/blob/main/docs/common-questions.md).
