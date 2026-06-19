/**
 * Conventional Commits — enforced by the commit-msg hook and CI.
 * Machine-parseable history is what lets Changesets derive versions and lets
 * Archer's agents author commits the pipeline can reason about.
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Agents (and humans) write detailed rationale in commit bodies — don't wrap-police them.
    "body-max-line-length": [0, "always"],
    "footer-max-line-length": [0, "always"],
  },
};
