# Manual end-to-end testing: Nia Agent + Planometry (extraction)

Hand-drive the full agent pipeline (SQL Server → extract → spool → chunk
upload → complete/failed, catalog push, heartbeats, retry/409 handling)
from your terminal, against a throwaway SQL Server test container and a
foreground fake Planometry server — no Docker sandbox, no real
Planometry, nothing that touches the dev DB. All commands below run from
the repo root unless noted; all `pnpm --filter @nia/agent run manual:*`
scripts shell out to plain scripts/`tsx`, no new dependencies.

**Before you start:** the agent's default config directory
(`/etc/nia-agent` on macOS/Linux) requires root. For manual testing,
point it at a scratch directory instead — open a terminal and run this
once per shell session you use below (every `nia-agent`/`manual:*`
command needs it):

```bash
export NIA_AGENT_HOME=/tmp/nia-agent-manual
```

**Also note:** the harness's throwaway password (`N!aExtractTest_2026`,
from `packages/extract/scripts/harness/config.sh`) contains a `!`. Most
interactive shells (zsh and bash both, by default) treat `!` as history
expansion even inside single quotes, so pasting a command with
`--password 'N!aExtractTest_2026'` can fail with something like `event
not found`. If you hit that, either run `set +H` (bash) /
`unsetopt BANG_HIST` (zsh) once per shell first, or break the quoting
around just the `!`: `'N'\!'aExtractTest_2026'`.

You'll use **4 terminals**: (A) the SQL harness lives in its own Docker
container, no terminal needed once started; (B) the fake Planometry
server (foreground); (C) the agent (foreground); (D) your driver
terminal for `connection add`/`doctor`/`status`/`manual:planometry:ctl`/
`manual:extract` commands. Export `NIA_AGENT_HOME` in both (C) and (D).

---

## 1. Start the SQL Server test harness

```bash
pnpm --filter @nia/agent run manual:sql:up
```

**What you should see:** a confirmation prompt —

```
This starts a throwaway SQL Server 2022 test container (amd64-emulated on Apple Silicon).
Confirm the dev sandbox (docker-compose.yml's postgres/redis/connector-*) is stopped, and Rosetta 2 is enabled. Continue? [y/N]
```

Answer `y`. It pulls/starts `nia-extract-mssql-test` on `localhost:14330`
and seeds `nia_extract_test` (`dbo.widgets`, `dbo.big_table` — 1.2M rows,
`dbo.vw_slow`, `reporting.sales`, `dbo.excluded_probe`). Wait for the
script to print that seeding finished before continuing — first boot can
take a minute or two.

## 2. Start the fake Planometry server (terminal B)

```bash
pnpm --filter @nia/agent run manual:planometry
```

**What you should see:**

```
[fake-planometry] push API listening at http://127.0.0.1:4455
[fake-planometry] control API listening at http://127.0.0.1:4456
[fake-planometry] use "pnpm --filter @nia/agent run manual:planometry:ctl <subcommand>" to drive it
```

Leave this running — every request the agent makes prints a line here
(catalog push, poll, chunk, heartbeat, complete/failed). This terminal
is your main window into what the agent is doing.

## 3. Generate and apply the read-only SQL login

```bash
pnpm --filter @nia/agent run manual:sql:readonly-apply
```

**What you should see:**

```
Generating read-only login script for login 'nia_agent_readonly' on database 'nia_extract_test'...
Applying to nia-extract-mssql-test...
Read-only login 'nia_agent_readonly' applied. Password: N!aExtractTest_2026 (throwaway test harness only, never a real secret).
```

No `sqlcmd` errors in between. This creates a `nia_agent_readonly` SQL
login scoped read-only to `nia_extract_test`, with cancel-visibility
grants (needed for the `check-running` step later).

## 4. Issue an agent key (terminal D)

```bash
pnpm --filter @nia/agent run manual:planometry:ctl issue-key
```

**What you should see:** a bare UUID printed, e.g. `3f1b2c4a-...`. Copy
it — you'll use it as `--agent-key` next. Terminal B also logs
`[fake-planometry] issued agent key: <uuid>`. From this point on, the
fake server requires every request to carry this key.

## 5. Add a connection

```bash
pnpm --filter @nia/agent run dev connection add \
  --id test1 --label "Harness SQL Server" \
  --host localhost --port 14330 --database nia_extract_test \
  --user nia_agent_readonly --password 'N!aExtractTest_2026' \
  --encrypt true --trust-server-certificate true \
  --planometry-url http://127.0.0.1:4455 \
  --agent-key '<paste the uuid from step 4>'
```

**What you should see:**

```
added connection test1 (Harness SQL Server)
```

## 6. `doctor` — confirm everything is green

```bash
pnpm --filter @nia/agent run dev doctor test1
```

**What you should see:** every check `[PASS]`, e.g.:

```
test1 (Harness SQL Server):
  [PASS] SQL Server reachable — connected to localhost:14330
  [PASS] TLS negotiated — ...
  [PASS] login succeeded — ...
  [PASS] read-only login permissions — ...
  [PASS] cancel visibility — ...
  [PASS] disk space — ...
  [PASS] Planometry reachable — ...
  [PASS] clock skew — ...
  [PASS] agent key accepted — ...
```

If anything fails, fix it before continuing — don't proceed with a red
doctor.

## 7. Start the agent in the foreground (terminal C)

```bash
export NIA_AGENT_HOME=/tmp/nia-agent-manual
pnpm --filter @nia/agent run dev start
```

**What you should see:** nothing prints here immediately (the agent logs
structured JSON to `$NIA_AGENT_HOME/logs/agent.log`, not stdout, except
warnings/errors). Instead, **watch terminal B** — within a couple of
seconds you'll see the agent pinging and polling for work:

```
[fake-planometry] ping
[fake-planometry] work poll: connection=test1 -> empty (poll again in 1s)
[fake-planometry] work poll: connection=test1 -> empty (poll again in 1s)
```

The catalog itself isn't pushed yet — it's pushed lazily the first time
a sync actually runs (next step), not proactively at startup. Leave this
terminal running for the rest of the walkthrough.

## 8. Sync a small table (terminal D)

```bash
pnpm --filter @nia/agent run manual:planometry:ctl queue \
  --connection-id test1 --run-id run-widgets --table dbo.widgets
```

**What you should see** on terminal B — this is also where the catalog
arrives, since it's pushed once lazily on the first sync of a process
lifetime:

```
[fake-planometry] queued run=run-widgets connection=test1 table=dbo.widgets
[fake-planometry] work poll: connection=test1 -> run=run-widgets table=dbo.widgets
[fake-planometry] catalog push: connection=test1 fingerprint=... tables=5
[fake-planometry] chunk: run=run-widgets seq=0 rows=3 -> ok
[fake-planometry] complete: run=run-widgets rows=3 chunks=1
```

(Later syncs in this same agent process won't repeat the catalog push —
`syncCatalogIfNeeded` skips it once the fingerprint is unchanged.)

Confirm from terminal D:

```bash
pnpm --filter @nia/agent run dev status
```

should show `test1: ... last sync ... (3 rows)`.

## 9. Sync the 1.2M-row table

```bash
pnpm --filter @nia/agent run manual:planometry:ctl queue \
  --connection-id test1 --run-id run-big --table dbo.big_table
```

**What you should see:** terminal B logs several `chunk: run=run-big
seq=N rows=... -> ok` lines (one per spooled chunk) followed by
`complete: run=run-big rows=1200000 chunks=N`. This takes longer than
the small-table sync — give it time.

## 10. A filtered sync

```bash
pnpm --filter @nia/agent run manual:planometry:ctl queue \
  --connection-id test1 --run-id run-filtered --table dbo.widgets \
  --columns name,price,is_active \
  --filter '[{"column":"is_active","operator":"eq","value":true}]'
```

**What you should see:** `complete: run=run-filtered rows=2 chunks=1`
(only `alpha` and `disc%ount_promo` have `is_active = 1` in the seed
data) and only the 3 requested columns.

## 11. The slow view — watch heartbeats

`dbo.vw_slow` takes several seconds but the agent's default heartbeat
interval is 60s, too long to observe in a short demo. Restart the agent
(terminal C: `Ctrl+C`, then) with a shortened interval just for this
step:

```bash
export NIA_AGENT_HOME=/tmp/nia-agent-manual
NIA_AGENT_HEARTBEAT_INTERVAL_MS=2000 pnpm --filter @nia/agent run dev start
```

Then from terminal D:

```bash
pnpm --filter @nia/agent run manual:planometry:ctl queue \
  --connection-id test1 --run-id run-slow --table dbo.vw_slow
```

**What you should see** on terminal B: one or more
`[fake-planometry] heartbeat: run=run-slow count=N` lines while the view
is still computing, then the single-row chunk and `complete`.

## 12. Drop a chunk — watch the retry

Arm the drop fault *before* queuing the sync (arming doesn't require the
run to exist yet, and `dbo.widgets` is small enough that queuing first
is a real race — the chunk can land before the fault call even starts):

```bash
pnpm --filter @nia/agent run manual:planometry:ctl fault-drop \
  --run-id run-drop --seq 0
pnpm --filter @nia/agent run manual:planometry:ctl queue \
  --connection-id test1 --run-id run-drop --table dbo.widgets
```

**What you should see** on terminal B:

```
[fake-planometry] fault armed: run=run-drop seq=0 will be dropped on first attempt
[fake-planometry] queued run=run-drop connection=test1 table=dbo.widgets
[fake-planometry] work poll: connection=test1 -> run=run-drop table=dbo.widgets
[fake-planometry] chunk: run=run-drop seq=0 rows=3 -> dropped (fault, connection reset)
[fake-planometry] chunk: run=run-drop seq=0 rows=3 -> ok
[fake-planometry] complete: run=run-drop rows=3 chunks=1
```

Same `seq=0` both times — that's the agent retrying the exact same
chunk after the dropped connection.

## 13. A 409 — watch cleanup

Same ordering note as step 12 — arm the fault *before* queuing, since
`dbo.widgets` is fast enough that queuing first is a real race:

```bash
pnpm --filter @nia/agent run manual:planometry:ctl fault-409 \
  --run-id run-409 --seq 0
pnpm --filter @nia/agent run manual:planometry:ctl queue \
  --connection-id test1 --run-id run-409 --table dbo.widgets
```

**What you should see** on terminal B:

```
[fake-planometry] fault armed: run=run-409 seq=0 will always get 409
[fake-planometry] queued run=run-409 connection=test1 table=dbo.widgets
[fake-planometry] work poll: connection=test1 -> run=run-409 table=dbo.widgets
[fake-planometry] chunk: run=run-409 seq=0 rows=3 -> 409 (fault)
```

No `complete` or `failed` line follows — a 409 means Planometry
superseded the run, which `runSync` treats as neither success nor a
local failure. Confirm the spool was cleaned up:

```bash
ls $NIA_AGENT_HOME/spool/run-409 2>&1
```

should print `No such file or directory`. `status` won't show a new
error for this connection either.

## 14. Stop the agent mid-sync — watch it report failed

Queue the big table again, then interrupt partway through:

```bash
pnpm --filter @nia/agent run manual:planometry:ctl queue \
  --connection-id test1 --run-id run-interrupt --table dbo.big_table
```

Wait a couple of seconds for terminal B to show activity for this run
(`chunk: run=run-interrupt ...` and/or, since terminal C is still the
same process you started with the heartbeat override in step 11,
`heartbeat: run=run-interrupt ...`), then go to terminal C and press
`Ctrl+C`.

**What you should see** on terminal B, shortly after:

```
[fake-planometry] failed: run=run-interrupt error=aborted
```

(or a similar abort-related error). Terminal C exits cleanly back to the
shell prompt. From terminal D:

```bash
pnpm --filter @nia/agent run dev status
```

should show `test1: ... last error ...` for this connection, and

```bash
tail -5 $NIA_AGENT_HOME/logs/agent.log
```

should include a `"sync_failed"` JSON line.

## 15. Direct extract + Ctrl+C cancel (bypasses Planometry entirely)

```bash
pnpm --filter @nia/agent run manual:extract catalog --connection-id test1
```

**What you should see:** every table/view and its columns, with
`dbo.excluded_probe`'s unsupported-type columns listed under
`[excluded]`.

Now run a long extract and cancel it:

```bash
pnpm --filter @nia/agent run manual:extract extract \
  --connection-id test1 --table dbo.vw_slow
```

While it's still running, press `Ctrl+C`.

**What you should see:**

```
cancelling query...
columns: row_count:number, max_n:number
rows received: 0
keep-alives: N
error: aborted
```

Then confirm the cancelled query is actually gone from SQL Server:

```bash
pnpm --filter @nia/agent run manual:extract check-running \
  --connection-id test1 --match "vw_slow"
```

**What you should see:** `running: false`.

(Optional: re-run the same `extract` command without interrupting it to
see a clean, uncancelled run — `error` absent, `trailer row count: 1`.)

## 16. `job add` / `job run` — a replace load against the fake Planometry server (v4 Internal Table)

This exercises the newer `job`-based path (full-table `replace` loads against
a v4 Internal Table), separate from the `connection`-based chunk-push path
used in steps 8-14 above. It reuses the same terminal B fake server (still
running) and terminal D.

Create a fake Internal Table (terminal D):

```bash
pnpm --filter @nia/agent run manual:planometry:ctl create-table \
  --id ds-widgets \
  --columns '[{"name":"id","type":"Number","isKey":true},{"name":"name","type":"Text"},{"name":"price","type":"Number"}]'
```

**What you should see:** a JSON object with `tableId: "ds-widgets"`,
`tableUrl: "http://127.0.0.1:4455/api/datasources/internal-tables/ds-widgets"`
and a generated `pushKey`. Copy the `tableUrl` and `pushKey`.

Add the job, pasting the `pushKey` when prompted:

```bash
pnpm --filter @nia/agent run dev job add \
  --connection test1 --table dbo.widgets \
  --target-url http://127.0.0.1:4455/api/datasources/internal-tables/ds-widgets \
  --map id=id --map name=name --map price=price \
  --yes
```

**What you should see:** the proposed mapping printed, then `added job
<id> (dbo.widgets)`. Copy `<id>`.

Run it:

```bash
pnpm --filter @nia/agent run dev job run <id>
```

**What you should see:** a one-line run summary — rows sent, rows skipped,
parts, duration, and Planometry's returned `rowCount`/`version` — and
terminal B logging the push. Confirm the rows landed:

```bash
pnpm --filter @nia/agent run manual:planometry:ctl rows --table-id ds-widgets
```

should list all of `dbo.widgets`'s rows. Running `job run <id>` again
performs a second full replace (same table, new load) — rows are
unchanged if the source hasn't changed.

`job update <id> --on-null-key skip` (or `stop`, the default) and
`--allow-empty-replace` are available the same way as on `job add`, to
exercise the null-key and zero-row safety rules.

## 17. Tear everything down

- Terminal C: `Ctrl+C` if still running.
- Terminal B: `Ctrl+C` — prints `[fake-planometry] shutting down...` and
  exits.
- SQL harness:

```bash
pnpm --filter @nia/agent run manual:sql:down
```

**What you should see:** the `nia-extract-mssql-test` container stopped
and removed, no prompt (this one never touches anything but the
throwaway container).

---

## Reference: all `manual:*` scripts

| Script | What it does |
| --- | --- |
| `manual:sql:up` | Confirm + start the throwaway SQL Server 2022 harness (port 14330) |
| `manual:sql:down` | Stop the harness, no prompt |
| `manual:sql:readonly-apply` | Generate + apply a read-only SQL login to the harness |
| `manual:planometry` | Foreground fake Planometry server (push API :4455, control API :4456), verbose logging |
| `manual:planometry:ctl <cmd>` | Drive the fake server: `issue-key`, `queue`, `refresh-catalog`, `fault-drop`, `fault-409`, `slow` |
| `manual:extract <cmd>` | Direct extraction bypassing Planometry: `catalog`, `extract`, `check-running` |

Agent commands (`connection add/list/remove/test`, `sql readonly`,
`doctor`, `status`, `start`, `healthcheck`) run via
`pnpm --filter @nia/agent run dev <args>` (no `--` separator — this
pnpm version inserts a literal `--` token into argv when one is used,
breaking the CLI's argument parsing), same as always — no new scripts
needed for those.

Env vars used above: `NIA_AGENT_HOME` (required — see top of doc),
`NIA_AGENT_FAKE_PLANOMETRY_PORT` / `NIA_AGENT_FAKE_CONTROL_PORT`
(override the fake server's ports, default 4455/4456),
`NIA_AGENT_HEARTBEAT_INTERVAL_MS` (override the sync heartbeat interval,
default 60000 — only needed for step 11).
