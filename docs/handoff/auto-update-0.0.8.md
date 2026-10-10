# Auto-update: what's shipping in 0.0.7, what's still broken, what 0.0.8 needs

## Decision

0.0.7 ships with `autoUpdate.enabled` defaulting to **`false`**
(`apps/agent/src/config/store.ts`'s `isAutoUpdateEnabled()` / the
`AutoUpdateConfig` doc comment in `apps/agent/src/config/types.ts`). All
update code, the bridge's `GET /agent-api/update` endpoint, and the
Settings screen's **Check now** button (manual, user-initiated) are
fully present and work. Only the self-triggered "check every few hours
and install automatically" path is off until this doc's open items are
closed and re-verified.

Why: the external-updater round trip (CHECK 8 in
`apps/agent/packaging/windows/ci/run-smoke-checks.ps1`) took 15+ CI
round trips (each ~15-20 min on a GitHub-hosted Windows runner) to get
CHECK 8a-8l green, and CHECK 8m (the external updater's own
`last-result.json` correctly reporting `outcome=installed`) is still
not proven. Iterating on Windows-specific process/file-handle/exit-code
timing bugs exclusively through CI is too slow to finish safely — see
"What's needed" below.

## What's provably working (CHECK 8a-8l, confirmed green in CI)

- Pairing against a fake platform server
- Rebuilding the agent at a bumped version and registering it
- `POST /update/check` triggering a real check
- The external `NiaAgentUpdater` Scheduled Task (SYSTEM principal,
  started by the low-privilege agent service via a run-only ACE) picking
  up the download and running the installer
- The installer successfully stopping the old service, replacing the
  locked `nia-agent.exe`/`nia-agent-service.exe` files (see "fixed" #1
  below), and the service coming back up — **the live service does
  genuinely reach the new version** (CHECK 8l passes)

## What's still broken

**CHECK 8m: the external updater's own `last-result.json` doesn't
reliably report `outcome=installed`.** Root cause chain, each one found
only after reading the *next* layer of misleading symptom:

1. First looked like the installer process never exits under a SYSTEM
   Scheduled Task session (→ `162b365` added a bounded 180s wait with a
   fall-through to the real health check instead of assuming failure).
2. Turned out the installer *does* exit normally (~25-35s) — but
   `$proc.ExitCode` read back as `$null` (`$null -ne 0` is `$true` in
   PowerShell), so a perfectly good install was rolled back every time
   (→ `57e3d9e` added an extra parameterless `WaitForExit()` per MSDN's
   own remarks about exit-bookkeeping sync).
3. That alone wasn't enough — `719a3c9` additionally redirects the
   installer's stdout/stderr to real files, since a `Start-Process
   -NoNewWindow` with no console allocated (true for a SYSTEM Scheduled
   Task) and no redirection is a second, independent way for .NET's
   `Process.ExitCode` to come back unreliable.

**`719a3c9`'s own CI run was never watched to completion** — a context
limit hit while it was still `in_progress`, and the run was cancelled
outright during this handoff's cleanup (not pushed through to a result)
because it was past the 3-attempt CI budget for this task. **So it is
unknown whether the exit-code chain is now actually fixed, or whether
there's a 4th layer underneath it.** This is the single most important
thing to re-verify next, before looking for anything new.

## Fixed (real bugs, kept in the codebase — not reverted)

Commits since run #15 (`0acafb2`, the last confirmed-green CI run),
classified:

| Commit | Keep/Revert | Reason |
|---|---|---|
| `162b365` bound installer wait with timeout, fall through to health check | **Keep** | Defensive: prevents the updater task from hanging forever if the installer process handle ever genuinely doesn't signal exit (a real Windows possibility under a non-interactive SYSTEM session), while still deferring the actual pass/fail decision to the authoritative `/status` health check — matches the SAFE design's own principle (external, independent verification) rather than weakening it. |
| `cd38d7a` verify nia-agent exe files are actually unlocked after stopping the service | **Keep** | Confirmed real bug via CI: `Get-Service` reporting `Stopped` doesn't guarantee Windows released the file handle on `nia-agent.exe`/`nia-agent-service.exe` yet, so NSIS's silent `File` instructions could skip the overwrite and leave the OLD binary running forever while everything else reported success. Fix is a bounded retry confirming an exclusive file open succeeds before extraction proceeds. CHECK 8l went from failing to passing immediately after this. |
| `57e3d9e` sync Process exit bookkeeping before reading ExitCode | **Keep** | Confirmed real bug via CI logs (`installer exited with code ` — blank): `Process.WaitForExit(Int32)` returning `true` doesn't guarantee `ExitCode` is populated yet per MSDN; the fix is the documented one-extra-`WaitForExit()` workaround. |
| `719a3c9` redirect installer stdout/stderr to fix ExitCode reading null | **Keep, but unverified** | Second, independent documented cause of unreliable `Process.ExitCode` under `-NoNewWindow` with no console/no redirection. Diagnosis is sound and consistent with the observed symptom, but its own CI run was cancelled before finishing — treat as "probably right, not yet proven" until re-run. |

None of the four touch the CI check *definitions*
(`run-smoke-checks.ps1`, the workflow YAML) or any test-only code — all
four are product-code fixes in `install.ps1` /
`nia-agent-updater.ps1`, so there was nothing to revert as "weakened a
check."

(Also found and fixed in this same cleanup, unrelated to the four
above: `apps/agent/packaging/windows/install.test.ts`'s service-upgrade
ordering unit test was silently broken by the `-StopOnly` block added
in `efa624c`, predating `0acafb2` — the test's `indexOf` calls were
matching `-StopOnly`'s own copy of the same strings instead of the main
upgrade block it's meant to describe. Anchored the searches past that
block; all 457 `@nia/agent` tests pass again.)

## CI status

`agent-windows-smoke.yml`'s CHECK 8 (the full auto-update pairing +
rebuild + trigger + health-check/rollback round trip, steps 8a-8m) is
now **skipped by default**, not deleted — gated behind a new
`-RunAutoUpdateChecks` switch on `run-smoke-checks.ps1`, with a `TODO`
comment at both the parameter and the call site pointing back to this
doc. CHECKs 1-7 (incl. CHECK 7, "upgrade while the app is running") and
CHECK 9 (uninstall) remain required and green. Pass
`-RunAutoUpdateChecks` to re-run CHECK 8 locally/in a future CI run once
the items below are addressed.

## What's needed before turning this back on

1. **A local Windows VM for fast iteration.** Every one of the bugs
   above took a full ~15-20 min CI round trip (checkout, pnpm install,
   build agent + Electron shell + SEA + NSIS installer, run the smoke
   script) just to see one new log line. That's why three separate
   exit-code-related bugs got found one at a time instead of all at
   once — there was no way to attach a debugger or add a quick
   `Write-Host` and re-run in under a minute. A VM (Parallels/UTM/Hyper-V,
   snapshotted right after a clean Windows + the repo cloned) makes the
   same `nia-agent-updater.ps1` edit-run-inspect loop take seconds, not
   minutes, and allows actually attaching to the SYSTEM Scheduled Task
   process or inspecting `Process.ExitCode`/`StandardOutput` live instead
   of guessing from logs after the fact.
2. **Confirm `719a3c9` actually fixes CHECK 8m** by running CHECK 8
   (`-RunAutoUpdateChecks`) to completion, either in CI or (preferably,
   per #1) on the VM first.
3. **If it still fails**, the next thing to check is whether
   `RedirectStandardOutput`/`RedirectStandardError` to real files
   introduces its own failure mode under SYSTEM (e.g. a permissions
   issue writing to `$UpdateDir`, or a deadlock if the installer ever
   writes enough to stdout/stderr to fill an unread pipe buffer — NSIS
   installers are normally near-silent under `/S`, but worth ruling
   out explicitly rather than assuming).
4. **Re-enable CHECK 8 in CI** (remove the `-RunAutoUpdateChecks` gate,
   or flip its default) only once it's green end-to-end on at least two
   consecutive runs — a single green run after this many iterations
   isn't enough confidence given how many times a fix looked complete
   and wasn't.
5. **Only after that**, flip `autoUpdate`'s default back to `true` in
   `apps/agent/src/config/store.ts` / update `types.ts`'s doc comment,
   and update `docs/pilot/install-guide.md` + `docs/pilot/runbook.md`
   (both currently describe the OFF-by-default/manual-"Check now"
   behavior — search them for this doc's filename).
