# TODO

- Chore: 2 stale `/login`/`/signup` visual snapshots in
  `apps/web/test-results` are failing pixel-diffs (pre-existing, not a
  regression from any session's work). Re-baseline them.
- ~~Chat feature requires an organization — allow individual/personal-workspace
  users~~ — **reconciled and closed with artifacts** (chat.spec.ts 10/1/0,
  chat-smoke exit 0, user-keyed Redis keys captured live). See
  `docs/decisions.md` for the standing rule on what counts as a proven test
  run, and commit `01436a0` for the code + coverage.
