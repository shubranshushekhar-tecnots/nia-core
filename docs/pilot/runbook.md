# Nia Core Agent — runbook

Audience: whoever operates the agent day to day. What each job status
and error means, and what to do about it. Everything here comes from
`nia-agent status` and `nia-agent doctor`.

## Job health (shown in `nia-agent status`)

| Status | Meaning | What to do |
|---|---|---|
| `ok` | The job is running on schedule with no unresolved failure. | Nothing. |
| `failing` | The most recent run(s) failed, but the agent is still retrying automatically on schedule. | Check the error class below for that job; most of these clear up on their own. If it keeps failing, see the error's row. |
| `paused` | The agent stopped running this job automatically. This only happens for the error classes marked "pauses" below. | Fix the underlying issue, then run `nia-agent job resume <id>`. |

## Last run result (shown per job in `nia-agent status`)

| Result | Meaning |
|---|---|
| `completed` | The last run finished and sent its rows successfully. |
| `failed` | The last run did not complete — see its error class below. |
| `skipped` | A scheduled run was skipped, either because the job is paused or because a previous run of the same job was still in progress when the next one was due. Not an error by itself. |

## Error classes

Shown as `[error class]` in `nia-agent status`, alongside the error
message. "Pauses" means the job stops running until you run `nia-agent
job resume`; everything else keeps retrying on its normal schedule (a
few classes also get fast automatic retries, noted below).

| Error class | What it means | Pauses? | What to do |
|---|---|---|---|
| `config` | Something about the job's own setup is invalid — for example the destination rejected the agent's credentials, or a required setting is missing/bad. | Yes | Check the destination credentials/settings for this job, fix them, run `nia-agent job test <id>` to confirm, then `nia-agent job resume <id>`. |
| `schemaDrift` | The destination's columns have changed since this job was set up. | Yes | Review what changed at the destination, update the job's mapping if needed (`nia-agent job update`), confirm with `nia-agent job test <id>`, then resume. |
| `typeMismatch` | A value from a column didn't fit the type the destination expects for it. | Yes | Check the source column and the job's mapping for that column, fix the mismatch, then resume. |
| `nullKey` | A row had a missing or blank value in the key column, and the job is set to stop rather than skip such rows. | Yes | Clean up the source data, or re-run `nia-agent job update` with `--on-null-key skip` if skipping those rows is acceptable, then resume. |
| `massDelete` | A sync noticed it would delete a larger share of destination rows than allowed, and refused rather than risk an accidental mass delete. | Yes | Confirm a deletion that large is actually expected. If so, re-run with a higher `--max-delete-percent`, or run manually with `nia-agent job run <id> --allow-mass-delete`. Then resume. |
| `transient` | A network problem, or a temporary (5xx) response from the destination. | No — retries automatically at 1, 5, and 15 minutes | Usually nothing; it recovers on its own. If it keeps happening, check connectivity to the destination. |
| `diskSpace` | The agent's local staging area is low on free disk space. | No — retries automatically at 1, 5, and 15 minutes | Free up disk space on the agent machine. |
| `lockTaken` | Another sync against the same database server was already running (the agent only runs one query at a time per server, by design). | No | Nothing — it tries again on the next scheduled run. |
| `rejected` | The destination flatly rejected the request (a bad-request response, not a temporary one). | No | Check the job's destination settings; if unclear, contact Nia support with the job ID and timestamp. |
| `mismatch` | The destination reported back a different row count than what the agent sent. | No | Usually transient. If it recurs for the same job, contact Nia support. |
| `emptyReplace` | A full-reload run found zero rows to send, and the job isn't configured to allow that (a safeguard against accidentally wiping the destination from an empty source read). | No | Confirm the source table actually has data. If zero rows is genuinely expected sometimes, run `nia-agent job update <id> --allow-empty-replace` once, then re-run the job. |
| `aborted` | The run was stopped mid-way — for example the agent service was restarted. Not a real failure. | No | Nothing — it runs again on schedule. |
| `other` | Anything that doesn't fall into one of the classes above. | No | Check `nia-agent status` for the error message; contact Nia support if it recurs. |

## Updates

**Updates are manual** (0.0.7+ — see `docs/handoff/auto-update-0.0.8.md`
for why automatic/background installs stay off). The agent checks for
a newer version on every open and shows a banner if one's available;
**Check for updates** (Settings → Updates) does the same check on
demand. **Update now** downloads it, verifies its checksum, and
launches the installer directly — Windows shows its normal UAC prompt,
macOS its normal administrator password prompt — then the agent
reopens with pairing/connections intact. The **Automatic updates**
toggle still exists in Settings but has no effect in this release.

| Symptom | What it means | What to do |
|---|---|---|
| Agent's screen (Settings → Updates) shows a version is available but **Update now** doesn't seem to do anything | The download or checksum verification hasn't succeeded yet, or the installer launched but its UAC/admin-password prompt wasn't approved. | Click **Check for updates** then **Update now** again. If a prompt appeared and was dismissed, run it again and approve the prompt this time. Confirm the machine has outbound HTTPS access (same requirement as pairing/check-ins). |
| Agent's screen shows "Installer launched — finish it in the window that opened" and doesn't go away | The installer window (UAC/admin-password prompt or the installer UI itself) is still open and waiting for you. | Switch to that window and finish the install. |
| `nia-agent status` keeps reporting the old version for more than a day after you know a newer one shipped | Updates are manual — nobody has clicked **Update now** yet — or the agent hasn't been able to reach the platform at all (a bigger problem than updates alone — check-ins would also be failing). | Open Settings → Updates and click **Check for updates** / **Update now**; check `nia-agent status` for recent check-in activity. |
| An update's installer ran but the agent now won't pair/check in, or a job that worked before now fails | The new version has a real problem that a manual install doesn't automatically catch (unlike the dormant automatic path, there is no post-install health-check/rollback for this flow). | Reinstall the previous or latest known-good version by hand from `docs/pilot/install-guide.md`'s normal install steps (safe to re-run over an existing install — pairing and configuration are untouched), then contact Nia support with the version numbers involved. |

## See also
- `docs/pilot/install-guide.md` — setup.
- `docs/pilot/what-leaves-your-network.md` — what data goes where.
