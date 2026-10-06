> **Superseded.** This describes an earlier version of the agent's setup
> protocol (no pairing step, a different `connection add` flag set, and
> `agent doctor` checks that no longer exist). For current, generic
> install instructions, see `docs/pilot/install-guide.md`. Kept here for
> GMS-pilot-specific history only.

# GMS install guide — Nia Core Agent

Audience: GMS IT. Installs the on-premise Nia Core Agent that reads GMS's 7
`SummitERP_*` SQL Server 2008 databases and pushes rows to Planometry.
The agent never writes to SQL Server, never stores row data at rest, and
makes no inbound network connections — it only needs outbound HTTPS to
Planometry.

## 1. Prerequisites

- **Node.js 20 or later** (unless running under Docker — see §6 Option A)
  on the host that will run the agent. This host must have network access
  to the SQL Server instance (same LAN or a routed network) and outbound
  HTTPS access to Planometry's endpoint.
- A SQL Server login for the agent to use — created in step 3 below. The
  agent is never given `sa` or any administrative login.
- Local disk space for the spool directory (used to stage rows briefly
  before upload — see `docs/plans/planometry-integration.md` §4 for the
  spool design). A few hundred MB free is enough for typical chunk sizes;
  `agent doctor` (step 6) checks this.

> **Which long-term process option to use — confirm with GMS IT**: three
> are available (§6 below): Docker (works on any OS with Docker already
> installed), a Linux systemd service, or a Windows service. Pick whichever
> matches GMS's existing operational tooling — see
> `docs/plans/planometry-integration.md` §9.

## 2. Install the agent

1. Copy the `apps/agent` build output (or the whole repo, for the pilot)
   onto the agent host.
2. From `apps/agent`, install dependencies and build:
   ```
   pnpm install
   pnpm --filter @nia/agent build
   ```
3. Confirm the CLI runs:
   ```
   node dist/index.js status
   ```
   A fresh install prints "agent has not recorded a start yet" — that's
   expected; there's no config yet.

All agent state (config, encrypted secrets, the spool directory, logs,
and run status) lives under one app-data directory:
- Windows: `%ProgramData%\NiaAgent`
- Linux: `/etc/nia-agent`

This directory is created automatically the first time a command needs
it. It never contains row data, and secrets inside it are encrypted at
rest (see `docs/plans/planometry-integration.md` §3) — but it should
still be access-restricted to the service account the agent runs under,
the same as any directory holding database credentials.

## 3. Generate the SQL Server readonly login

Run this on a machine with the agent installed (it doesn't need to be the
SQL Server box itself — it only generates a `.sql` script):

```
node dist/index.js sql readonly --login nia_agent --databases SummitERP_1,SummitERP_2,SummitERP_3,SummitERP_4,SummitERP_5,SummitERP_6,SummitERP_7 --out nia-readonly-setup.sql
```

This writes a T-SQL script (compatible with SQL Server 2008 — no syntax
newer than that) that:
- Creates one server login (`nia_agent` above, or whatever `--login` you
  choose) with a **placeholder password** — the script never contains a
  real password, and must not be committed anywhere with one filled in.
- Grants `VIEW SERVER STATE` at the server level (needed so the agent can
  see its own running query in `sys.dm_exec_requests` — this is how it
  confirms a cancelled query actually stopped; it is a read-only
  visibility grant, not a write permission).
- For each database listed, creates a database user mapped to the login,
  adds it to `db_datareader`, and grants `VIEW DEFINITION` (needed to read
  the schema/catalog).
- Grants **no write permission anywhere** — no `db_datawriter`, no
  `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`db_owner`/`CONTROL`. This is
  enforced by a test (`sqlReadonlyScript.test.ts`) that scans the
  generated SQL for exactly these keywords and fails if any appear.

**Hand `nia-readonly-setup.sql` to a GMS DBA.** They should:
1. Open it in SSMS or `sqlcmd` and review it (it's short and fully
   commented — every statement is idempotent, so re-running it is safe).
2. Replace `<CHANGE_ME_STRONG_PASSWORD>` with a strong password of their
   choosing, generated/stored however GMS normally handles service
   account credentials.
3. Run the script against the SQL Server instance (as `sa` or an admin
   login with rights to create server logins).
4. Give the Nia team the login name and password out of band (not over
   email/chat) — it's needed for step 4 below.

## 4. Register each connection

One `connection add` per `SummitERP_*` database (7 total for GMS), each
pointing at the **same login** from step 3 but a different `database`:

```
node dist/index.js connection add \
  --id summit-erp-1 --label "SummitERP_1" \
  --host <sql-server-host> --port 1433 --database SummitERP_1 \
  --user nia_agent --password <the-password-from-step-3> \
  --encrypt false \
  --planometry-url <planometry-base-url>
```

Repeat for `SummitERP_2` through `SummitERP_7`, changing `--id`,
`--label`, and `--database` each time.

Notes on the flags:
- `--encrypt false` is appropriate for a LAN-only SQL Server 2008
  instance (its own default). If GMS requires TLS, set `--encrypt true`;
  if the instance can't negotiate TLS 1.2+ at all (SQL Server 2008 often
  can't), see `--allow-legacy-tls true` — documented in
  `docs/plans/planometry-integration.md` §Phase 1 as explicitly insecure
  and intended only for a private, trusted LAN. Try without it first.
- Credentials are encrypted at rest immediately; they are never written
  to `agent.config.json` in plain text.

Confirm each connection independently before moving on:
```
node dist/index.js connection test summit-erp-1
```
This connects and fetches a table/view catalog — it does not yet involve
Planometry. A failure here means the SQL Server side isn't right yet
(wrong host/port/database/credentials, or firewall/VPN); fix that before
step 5.

## 5. Run `agent doctor`

Once all 7 connections are added, run the full diagnostic:
```
node dist/index.js doctor
```
or for a single connection:
```
node dist/index.js doctor summit-erp-1
```

This checks, per connection: SQL Server reachability, TLS mode, login
credentials, read access (catalog), that the login truly can't write,
`sys.dm_exec_requests` visibility (cancel confirmation), spool directory
free disk space, Planometry URL reachability, and clock skew between
this host and Planometry. Every failing
check prints a suggested fix. **All 7 connections must show every check
passing (`[PASS]`) before starting the agent for the pilot** — see
`docs/pilot/gms-pilot-runbook.md` for the full pilot-day sequence.

## 6. Start the agent

Pick whichever of the three options below matches how GMS IT wants to run
long-lived processes. All three run the exact same `nia-agent start`
entry point and the exact same on-disk state/config directory shape — the
`connection add`/`doctor`/`status` steps above are identical no matter
which one you choose.

### Option A: Docker (most portable, needs Docker already installed)

Build the image once (from the repo, on any machine — doesn't need to be
the agent host):
```
docker build -f apps/agent/Dockerfile -t nia/agent .
```

Run it on the agent host, with a named volume for `/data` (the agent's
app-data directory inside the container — config, encrypted secrets,
spool, logs, status) so state survives restarts/upgrades:
```
docker volume create nia-agent-data
docker run -d --name nia-agent --restart unless-stopped \
  -v nia-agent-data:/data \
  nia/agent
```

Every CLI command from steps 3-5 above works identically inside the
container, e.g.:
```
docker exec nia-agent node dist/index.js status
docker exec nia-agent node dist/index.js connection add ...
docker exec nia-agent node dist/index.js doctor
```
The image's `HEALTHCHECK` runs `nia-agent healthcheck` every 30s (visible
in `docker ps`'s STATUS column) — unhealthy means the agent hasn't
recorded a start, or hasn't polled a connection in over 10 minutes (a
stuck/crashed loop), not a transient issue.

### Option B: Linux systemd service

Build the bundle once (from the repo, on any Linux or macOS machine —
doesn't need to be the agent host):
```
./apps/agent/packaging/linux/build-bundle.sh
```
This produces `apps/agent/packaging/linux/dist/nia-agent-linux-<version>.tar.gz`
— a self-contained tarball (built output + production `node_modules`, no
separate `pnpm install` needed on the target host).

Copy that tarball to the agent host, then install it as root:
```
sudo ./apps/agent/packaging/linux/install.sh nia-agent-linux-<version>.tar.gz
```
This creates a dedicated, unprivileged `nia-agent` system account, unpacks
the bundle to `/opt/nia-agent`, creates `/etc/nia-agent` (the agent's
app-data directory — config, encrypted secrets, spool, logs, status,
owned by `nia-agent`, mode 700), and installs+enables the
`nia-agent.service` systemd unit (restart-on-failure, 60s graceful-stop
timeout, hardened with `ProtectSystem=strict`/`NoNewPrivileges`). Re-run
`install.sh` with a newer tarball at any time to upgrade in place — it
never touches `/etc/nia-agent`.

Run steps 3-5 above as the `nia-agent` user, before starting the service
for the first time:
```
sudo -u nia-agent node /opt/nia-agent/dist/index.js connection add ...
sudo -u nia-agent node /opt/nia-agent/dist/index.js doctor
```
Then start it:
```
sudo systemctl start nia-agent
sudo systemctl status nia-agent
```

To uninstall (leaves `/etc/nia-agent` in place unless `--purge` is given):
```
sudo ./apps/agent/packaging/linux/uninstall.sh [--purge]
```

### Option C: Windows service

The agent ships as a single `nia-agent.exe` (a Node.js Single Executable
Application — no separate Node.js install needed on the target host),
wrapped as a Windows service by [WinSW](https://github.com/winsw/winsw)
v2.12.0 (MIT licensed, bundled in the install zip as
`LICENSE-WinSW.txt`).

**Prerequisite:** .NET Framework 4.6.1 or later (required by WinSW;
already present by default on Windows 10 / Server 2016 and later —
confirm on older hosts before installing).

Build the bundle once (from the repo, on any machine — macOS, Linux, or
Windows; cross-building a Windows executable from a non-Windows machine
is supported since the build only patches a downloaded `node.exe`
binary, it never executes it):
```
pnpm -r --filter @nia/extract --filter @nia/agent build
node apps/agent/packaging/windows/build-sea.mjs
node apps/agent/packaging/windows/build-bundle.mjs
```
This produces `apps/agent/packaging/windows/dist/nia-agent-windows-<version>.zip`
— a self-contained bundle (agent executable, the pinned+checksum-verified
WinSW binary renamed `nia-agent-service.exe`, the service descriptor, the
WinSW license, and install/uninstall scripts). No downloads happen on the
target host — everything is fetched and SHA-256-verified at build time:
the Node.js runtime used to build `nia-agent.exe` is checked against
nodejs.org's own published `SHASUMS256.txt`, and WinSW is checked against
a checksum obtained by downloading that exact release asset directly
from GitHub and hashing it independently (not copied from a third
party) — see the comments in `build-sea.mjs`/`build-bundle.mjs` for the
exact pinned versions and hashes.

Copy the zip to the agent host, unzip it, then run as Administrator:
```
powershell -ExecutionPolicy Bypass -File install.ps1
```
This installs to `%ProgramFiles%\NiaAgent`, creates
`%ProgramData%\NiaAgent` (the agent's app-data directory — config,
encrypted secrets, spool, logs, status — ACL'd to the agent's own
virtual service account, `NT SERVICE\nia-agent`, and local
Administrators only), and registers the `nia-agent` Windows service to
run as that virtual account rather than LocalSystem (restart-on-failure
with a 5s delay, 60s graceful-stop timeout — WinSW sends the process a
close signal that Node surfaces as `SIGINT`, which
`installGracefulShutdown` uses to abort in-flight work and clean up the
spool before WinSW force-kills it). A virtual service account needs no
password, is managed entirely by Windows, and gets no local-machine
access beyond what this install explicitly grants it — unlike
LocalSystem, which has broad access to the whole machine. Re-run
`install.ps1` with a newer zip at any time to upgrade in place — it
never touches `%ProgramData%\NiaAgent`.

POSIX file modes (0600/0700, used on Linux) have no effect on Windows —
`install.ps1`'s ACL (`NT SERVICE\nia-agent` + local Administrators only,
inherited permissions removed) is what actually protects config,
secrets, the master keyfile, and spool files. `nia-agent doctor` checks
this on every run and prints a `[WARN]` if any of those paths grant
access to an unexpected identity — including `NT AUTHORITY\SYSTEM` or
`LocalSystem`, in case the service is ever reconfigured to run with
broader privileges than intended — (e.g. a restore or a manual `icacls`
loosened it) — re-run `install.ps1`, or apply the `icacls` command the
warning prints, to re-lock it.

**Verify on a real Windows host** (could not be exercised on the build
machine used to make this change): that WinSW v2.12.0 accepts the
`<serviceaccount>` block's `<domain>NT SERVICE</domain>` /
`<user>nia-agent</user>` shape and installs the service non-interactively
without a password prompt; that the virtual account's SID resolves via
PowerShell's `Get-Acl`/`New-Object FileSystemAccessRule` *before* the
service has ever been installed (if `Set-Acl` throws "account could not
be translated", the ACL step in `install.ps1` needs to move to after
`& $ServiceExe install`); that the service actually starts and stays
running under `NT SERVICE\nia-agent` (check with `Get-Service nia-agent`
and Task Manager's "Users" column); and that outbound HTTPS to
Planometry still works under this account, including through any
authenticated corporate proxy GMS may have in front of outbound
internet traffic.

Run steps 3-5 above before starting the service for the first time:
```
& "$env:ProgramFiles\NiaAgent\nia-agent.exe" connection add ...
& "$env:ProgramFiles\NiaAgent\nia-agent.exe" doctor
```
Then start it:
```
& "$env:ProgramFiles\NiaAgent\nia-agent-service.exe" start
Get-Service nia-agent
```

To uninstall (leaves `%ProgramData%\NiaAgent` in place unless `-Purge` is
given):
```
powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge]
```

**Antivirus / SmartScreen note:** `nia-agent.exe` is built by patching a
genuine `node.exe` binary with the bundled agent code (Node's own
"Single Executable Application" mechanism) and is not code-signed by
Nia. This is expected to trigger Windows SmartScreen and may be flagged
by endpoint AV on first run, the same way any unsigned internal tool
would be. Verify the zip's SHA-256 (printed at the end of
`build-bundle.mjs`'s output) matches what GMS IT received before
installing, and allow/scan `nia-agent.exe` and `nia-agent-service.exe`
per GMS's normal unsigned-internal-tool process. If GMS requires
code-signed executables, sign `nia-agent.exe` with GMS's own
Authenticode certificate after the build (re-signing after postject
injection is normal — the build step's injection step prints a
"signature seems corrupted" warning for Node's own original signature,
which is expected and is overwritten by a subsequent real signing step).

---

Once running, `node dist/index.js status` (or, under Docker, `docker exec
nia-agent node dist/index.js status`) reports uptime and the last sync
time/row count/error per connection.

## See also
- `docs/pilot/gms-pilot-runbook.md` — pilot-day sequence and success
  criteria.
- `docs/pilot/shaping-data-for-planometry.md` — for GMS's DBAs, how to
  shape `SummitERP_*` tables into the hierarchies/facts Planometry
  expects.
- `docs/plans/planometry-integration.md` — full technical design.
