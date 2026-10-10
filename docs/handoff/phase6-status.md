# Phase 6: Agent Polish — Status Handoff

Written at handoff time. CI run referenced below was still `in_progress` when this
was written — the next session must check its result before anything else.

## The 4 check items (original ask)

1. Auto-update redesign (installer outside service process tree, service account
   can only start it, independent sha256+publisher re-verification, rollback+health
   check done externally, tray relaunch in user session)
2. Sync `apps/agent-desktop` version to match `apps/agent` (0.0.7)
3. Show GitHub CI run link/result for the extended Windows smoke test; if never
   run, push to `ci/agent-windows-smoke` and report the real result
4. Show git status + Phase 6 commit list; commit remaining work with explicit
   paths, user's git identity, plain messages, no push except the CI branch

## DONE

- **Item 2 (version sync)**: `apps/agent/package.json` and
  `apps/agent-desktop/package.json` both read `0.0.7`. Confirmed again this
  session — no drift.
- **Item 4 (git hygiene)**: all of my own work for this phase is committed (see
  commit list below). Nothing of mine is uncommitted.
- **Item 1 (auto-update redesign), code-complete**, implemented in earlier
  sessions and present on disk (verified via `ls`, not re-touched this segment):
  - `apps/agent/packaging/windows/sign.mjs` — Windows code signing (Azure Trusted
    Signing via dotnet/sign CLI, or classic `.pfx` via osslsigncode)
  - `apps/agent/packaging/macos/sign.mjs` + `entitlements.plist` — Developer ID
    codesign + notarytool
  - `apps/agent/packaging/build-release.mjs` — wires both into
    `pnpm run package:release` / `package:build` (`--release --allow-unsigned` gate)
  - `apps/agent/src/link/updateChecker.ts`, `updateClient.ts`, `updateInstaller.ts`
    — agent-side update check/download/handoff, surfaced in the agent-desktop UI
    Settings screen ("Automatic updates" toggle, "Check now" button)
  - `services/agent-bridge/src/app.ts` — `GET /agent-api/update` endpoint
  - `apps/agent/packaging/windows/updater/nia-agent-updater.ps1` — the privilege-
    separated SYSTEM-principal updater: a `NiaAgentUpdater` Scheduled Task that
    only the low-privilege `NT SERVICE\nia-agent` account can *start* (not
    reconfigure, via a SID-scoped run-only ACE); the external task independently
    re-verifies sha256 (+ Authenticode publisher when staged), snapshots the
    current install via `robocopy /MIR`, runs the installer, health-checks,
    rolls back on failure, and relaunches the tray app in the interactive user
    session via a one-time logon task.
  - `RELEASE.md` — full release steps documented.
- **Three real bugs found and fixed this segment** while driving item 3's CI
  verification (all in
  `apps/agent/packaging/windows/updater/nia-agent-updater.ps1`, all committed):
  1. `ddd2645` — **em-dash string-literal corruption**: the script had no UTF-8
     BOM and contained em-dashes inside `Write-Log` string literals. Windows
     PowerShell 5.1 reads BOM-less `.ps1` files under the system ANSI codepage
     (CP1252); the em-dash's UTF-8 bytes decode as a smart right-quote that the
     tokenizer treats as a premature string terminator, corrupting all parsing
     after it — with zero log output, because the failure happens before the
     script's own `trap`/logging logic ever runs. Same bug class as the
     already-fixed `582ce46` on `install.ps1`. Fixed by replacing em-dashes in
     string literals with plain ASCII and adding a UTF-8 BOM. Confirmed via CI
     artifact `check8.launcher.log` showing the exact parse errors beforehand,
     and their disappearance afterward.
  2. `1c8f908` — removed `-WindowStyle Hidden` from the `Start-Process` call that
     launches the NSIS installer (`/S` already makes it silent). This alone did
     **not** fix the next bug (see below) — the same exception recurred via the
     default Start-Process path.
  3. `d4b6221` — added `-NoNewWindow` to that same `Start-Process` call.
     `Start-Process` defaults to `UseShellExecute=true` (→ `ShellExecuteEx`)
     unless `-NoNewWindow`/`-RedirectStandard*`/`-Credential` is given, and
     `ShellExecuteEx` requires an interactive window station/desktop — unavailable
     to a SYSTEM process running via a non-interactive Scheduled Task. This threw
     `System.InvalidOperationException: This command cannot be run due to the
     error: The operation attempted is not supported.` `-NoNewWindow` forces the
     `CreateProcess` path instead (no shell, no window station needed). Confirmed
     via CI artifact `check8.updater.log` showing the exact exception beforehand.

## IN PROGRESS — exact state, what's half-done

- **Item 3 (CI result) is NOT yet confirmed green.** CI run
  `38036992583` (branch `ci/agent-windows-smoke`, headSha `d4b6221` — i.e. the
  current HEAD with all three fixes above) was **still `in_progress`** at
  handoff time:
  `https://github.com/shubranshushekhar-tecnots/nia-core/actions/runs/38036992583`
  — **the next session's first action must be `gh run view 38036992583 --json
  status,conclusion` to see if it finished, and if so, whether CHECK 8
  (auto-update) actually passed end-to-end.**
- History of CI attempts against this same code path, in order, for context:
  - `38034670866` (headSha `ddd2645`) — FAILED at CHECK 8. Progress: script now
    executes (previously zero output); failed on the `-WindowStyle Hidden`
    exception described above.
  - `38035838996` (headSha `1c8f908`) — FAILED at CHECK 8, same exception,
    recurring via the default/no-flag `Start-Process` path (confirms fix #2
    alone was insufficient, motivating fix #3).
  - `38036992583` (headSha `d4b6221`) — an earlier run attempt against this same
    commit failed at an unrelated step, "Build the NSIS installer" / `makensis
    not found — attempting to install via Homebrew` /
    `spawnSync brew ENOENT` (`apps/agent/packaging/windows/build-installer.mjs`'s
    `assertMakensisAvailable()` has a cross-platform-confused fallback that tries
    `brew` unconditionally). **This looked like a one-off CI runner flake**: the
    workflow (`.github/workflows/agent-windows-smoke.yml`) has a prior step
    "Install makensis + unzip" that runs `choco install -y nsis unzip` and
    appends `C:\Program Files (x86)\NSIS` to `GITHUB_PATH` — and in the run
    being watched at handoff time, that step reported `success`, so this may
    simply resolve on its own. **Not yet confirmed either way** — this is the
    run still polling as `in_progress` above (GitHub Actions run IDs are
    reused/re-attempted on reruns, so `38036992583` may represent either the
    original failed attempt or a fresh rerun; verify via the step list, not just
    the top-level conclusion).
  - If this run also fails at "Build the NSIS installer" again (not at CHECK 8),
    that points to a systemic gap in `build-installer.mjs` (e.g. it needs a
    Windows-specific `choco install nsis` fallback instead of unconditionally
    shelling out to `brew`), not a flake — would need an actual code fix in
    `apps/agent/packaging/windows/build-installer.mjs`'s `assertMakensisAvailable()`.

## LEFT

- Confirm CI run `38036992583`'s final status (see above) — if it failed again
  at "Build the NSIS installer", fix `assertMakensisAvailable()`'s brew-on-Windows
  fallback (pre-existing code, not touched this segment,
  `apps/agent/packaging/windows/build-installer.mjs:190-200`). If it reaches
  CHECK 8 and that check itself fails, read the newly-failing artifact logs the
  same way as before (`gh run download <id> -D <dir>`, inspect
  `check8.updater.log`/`check8.launcher.log`) rather than guessing.
- Once a run is fully green end-to-end (all checks A-I including CHECK 8),
  report the final real CI result back — this is the explicit ask of item 3,
  not yet satisfiable.
- No further commits needed for item 1/4 unless CI surfaces a new bug.

## Test failures

- No local unit/integration test failures encountered this segment — all
  issues were discovered exclusively via the Windows CI smoke workflow
  (`agent-windows-smoke.yml`), which exercises the real installer/updater
  end-to-end on an actual Windows runner. Local `pwsh` syntax validation
  (`[System.Management.Automation.PSParser]::Tokenize(...)`) was used before
  every commit to avoid blind CI round-trips for trivial syntax errors, and
  passed clean every time.

## Uncommitted files believed NOT mine

These are present in `git status` at handoff time but were never touched by me
in this phase (no relation to `apps/agent`/`apps/agent-desktop`/
`services/agent-bridge` auto-update or packaging work) — appear to be another
session's in-progress work on the web console, landing page, contact form, and
a `@nia/schemas` export-splitting refactor (the `services/agent-bridge/src/
app.ts` + `app.test.ts` diffs are part of that same schemas refactor, not agent
auto-update work):

- `apps/api/vitest.integration.config.ts`
- `apps/web/.env.production.example`
- `apps/web/src/app/console/users/[userId]/page.tsx`
- `apps/web/src/app/console/users/page.tsx`
- `apps/web/src/components/console/ConsoleUsersClient.tsx`
- `apps/web/src/components/console/styles.ts`
- `apps/web/src/components/landing/Footer.tsx`
- `apps/web/src/components/landing/LandingPage.tsx`
- `apps/web/src/components/landing/hero-story/niaHero.css`
- `apps/web/src/components/landing/hero-story/useNiaHeroEngine.ts`
- `apps/web/src/lib/downloads/manifest.ts`
- `packages/schemas/package.json`
- `packages/schemas/src/index.ts`
- `services/agent-bridge/src/app.test.ts`
- `services/agent-bridge/src/app.ts`
- `apps/web/src/app/api/contact/` (untracked directory)
- `apps/web/src/components/landing/ContactTab.tsx` (untracked)

## Phase 6 commit list (full, in order)

```
0690363 agent: Phase 6 -- code signing, auto-update, docs
3bf5c29 ci: capture agent.log and update handoff state files in CHECK 8
0bc9354 agent: CI -- diagnose CHECK 8 auto-update handoff failure
20c0be1 agent: route NiaAgentUpdater through a thin cmd launcher that captures stdout/stderr
ce24836 agent: fix NiaAgentUpdater run-only ACE duplicating on every upgrade
ddd2645 agent: fix same em-dash string-literal corruption in nia-agent-updater.ps1
1c8f908 agent: remove Start-Process -WindowStyle Hidden from updater (unsupported as SYSTEM)
d4b6221 agent: use -NoNewWindow instead of default Start-Process behavior for installer launch
```

Current branch `dev/next` HEAD = `d4b6221`. Also pushed to `origin/ci/agent-windows-smoke`
to trigger the CI runs listed above (no push to `dev/next`/`main`, per instruction).
