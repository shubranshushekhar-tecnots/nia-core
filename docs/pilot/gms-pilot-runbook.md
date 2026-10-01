# GMS pilot runbook

Audience: whoever is on point for the GMS pilot (Nia side), working with
GMS IT. Assumes `docs/pilot/gms-install-guide.md` is already done — all 7
`SummitERP_*` connections are registered on the agent host.

## 1. Pre-flight (before starting the agent)

Run `agent doctor` with no argument to check every registered connection
at once:
```
node dist/index.js doctor
```

**Do not proceed until every check for every one of the 7 connections
shows `[PASS]`.** Each failing line includes a suggested fix — common
ones:
- `login credentials accepted` failing → re-run `connection add` with the
  current password, or re-check the login with GMS's DBA.
- `login can't write` failing → the login was granted more than
  `db_datareader`/`VIEW DEFINITION`; re-run the generated script from
  `agent sql readonly` (step 3 of the install guide) to reset it, or ask
  GMS's DBA to revoke the extra grant directly.
- `sys.dm_exec_requests visible (cancel confirmation)` failing → the login
  is missing `GRANT VIEW SERVER STATE`; same fix as above.
- `spool directory free disk space` failing → free up space on the agent
  host, or point `spoolDir` at a volume with more room.
- `agent key accepted` failing → the agent key for that connection was
  rejected by Planometry; regenerate/update it on Planometry's side and
  re-run `connection add` with the new key.

If any check still fails after the suggested fix, stop and resolve it
before continuing — don't start the agent against a connection `doctor`
flags as unhealthy.

## 2. Start the agent

Follow the "Start the agent" step in `docs/pilot/gms-install-guide.md`.
Confirm it's running:
```
node dist/index.js status
```
Expect `uptime: <n>s (started <timestamp>)` and (once the first sync has
run) a line per connection.

## 3. Watch the first sync per connection

For each of the 7 connections, watch for its first catalog push and row
sync to complete:
```
node dist/index.js status
```
A healthy first sync shows `last sync <timestamp> (<N> rows)` with no
`last error`. Do this for all 7 before calling the pilot's first pass
successful — a connection that never gets a first sync, or errors
immediately, needs investigating before moving to the next one (don't
let 6 healthy connections mask one that's stuck).

## 4. Success criteria

For each connection, confirm:
- **Row counts match source.** Compare the row count the agent reports
  (`status`, or Planometry's own received-row count if visible) against
  a direct `SELECT COUNT(*)` against the same table(s) on GMS's SQL
  Server, for at least one spot-checked table per connection.
- **Sync timing is reasonable.** No sync should run dramatically longer
  than its row count would suggest — a stalled or very slow sync usually
  means a slow view or missing index on GMS's side, not an agent bug.
- **No ERP slowdown.** While a sync is running, watch SQL Server's own
  load from a separate session (not through the agent):
  ```sql
  -- currently running requests, including the agent's own query
  SELECT * FROM sys.dm_exec_requests;
  -- or, if sp_who2 is more familiar to GMS's DBA:
  EXEC sp_who2;
  -- overall wait stats, useful for a before/after comparison
  SELECT * FROM sys.dm_os_wait_stats;
  ```
  The agent runs at most one query at a time per SQL Server instance by
  design (see `docs/plans/planometry-integration.md` §5 — a semaphore
  keyed by `host:port`, default concurrency 1), specifically so 7
  connections against GMS's one SQL Server box never compound into
  concurrent load. If GMS reports a slowdown during a sync, capture the
  query from `sys.dm_exec_requests` at that moment — the fix is almost
  always an index on the queried table/view, not a change to the agent.

## 5. Rollback

If the pilot needs to be paused or GMS asks to stop:
1. Stop the agent process (however it was started in step 2 — kill the
   process, or stop the service once a proper service install exists).
   A graceful shutdown finishes or cleanly aborts any in-flight sync and
   reports it failed to Planometry rather than leaving it hanging (see
   `docs/plans/planometry-integration.md` §7).
2. Ask GMS's DBA to revoke/drop the readonly login created in the install
   guide's step 3, if GMS wants the access fully removed rather than just
   paused:
   ```sql
   -- per database the login had access to
   USE [SummitERP_1];
   DROP USER [nia_agent];
   -- once removed from every database
   USE [master];
   DROP LOGIN [nia_agent];
   ```
   (Substitute the actual login name used.) This is the same login name
   for all 7 databases, so it only needs dropping once, after being
   removed as a user from each database.
3. State this leaves things in: GMS's SQL Server is untouched otherwise
   (the agent never wrote anything to it). On Planometry's side, each
   connection's last-synced data remains as of the last successful sync
   — nothing is deleted on rollback; a fresh pairing/resync is needed to
   resume later.

## See also
- `docs/pilot/gms-install-guide.md` — install and connection setup.
- `docs/pilot/shaping-data-for-planometry.md` — for GMS's DBAs, if a
  table/view needs reshaping before Planometry can use it well.
- `docs/plans/planometry-integration.md` — full technical design.
