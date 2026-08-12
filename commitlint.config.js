/**
 * Conventional commits. The scope is free-form, but a commit touching a
 * specification should say so — `spec:` — because a behaviour change and its
 * spec update belong in the same pull request (AGENTS.md §6).
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0, 'always'],
  },
};
