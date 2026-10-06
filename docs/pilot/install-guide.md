# Nia Core Agent — install guide

Audience: your IT team. The Nia Core Agent is a small program that runs on a
machine inside your network. It reads from one or more of your databases
and sends rows out to a destination you choose — either straight to
Planometry (or another HTTPS address you control), or as part of a
workflow you built in Nia Core. It never writes to your database, never
makes any inbound network connection, and only needs outbound HTTPS
access.

## 1. What the machine needs

- A Windows, Linux, or macOS (Apple Silicon) machine the agent can run on
  continuously (a small server or VM is fine — it is not
  resource-intensive).
- Network access from that machine to your database.
- Outbound HTTPS access to the two addresses in step 2 below. No inbound
  ports need to be opened.
- A login to your database for the agent to use. This is a **read-only**
  login — see step 3. The agent should never be given an administrator
  login.
- A small amount of free disk space (a few hundred MB is enough) for the
  agent to briefly hold rows before sending them.

## 2. The two outbound addresses

Your firewall only needs to allow two outbound HTTPS destinations:

1. **The Nia Core platform address.** The agent uses this to register
   itself ("pairing") and to check in periodically — reporting that it's
   alive and the health of its jobs. Nia will give you this address.
2. **The destination address for your data.** This is wherever each job
   actually sends rows: Planometry's address, or an HTTPS address of your
   own. Each job has its own destination address — Nia will tell you
   which address(es) to allow for your setup.

No other outbound access is required, and nothing is ever accepted
inbound.

## 3. Generate the read-only database login

Run this once (it can be run on any machine with the agent installed —
it does not need to be the database server itself, and it does not touch
your database):

```
nia-agent sql readonly --login nia_agent --databases <your-database-name> --out nia-readonly-setup.sql
```

Use a comma-separated list for `--databases` if the agent will read more
than one database on the same server (e.g.
`--databases SalesDb,InventoryDb`).

This writes out a script for a database administrator to review and run
themselves — the agent never runs it. The script:

- Creates one login (named `nia_agent` above, or whatever you choose)
  with a **placeholder password only**. Your DBA replaces the placeholder
  with a real password before running it.
- Grants that login read access to the listed database(s) and the
  ability to see table/column definitions. This is enough for the agent
  to read rows and understand their shape.
- **Grants no write access of any kind** — no ability to insert, update,
  delete, or change anything. This is enforced automatically; the script
  cannot contain a write grant.
- Is safe to run more than once (it skips anything already in place).

Optional flags:
- `--schema <name>` — restrict the login's read access to one schema
  instead of the whole database.
- `--with-cancel-visibility true` — grants one additional, still
  read-only, permission that lets the agent confirm a stopped query
  actually stopped on the database server. Off by default; only add it
  if your DBA is comfortable with it.

Hand the generated `.sql` file to your DBA. They fill in a real password,
review it, and run it against the database server. Give the agent team
the login name and password through whatever secure channel you normally
use for credentials — never over email or chat.

## 4. Install the agent

Nia will provide an install bundle. Choose the one matching your
machine.

### Windows

1. Copy the zip bundle (`nia-agent-windows-<version>.zip`) to the target
   machine and unzip it.
2. Open PowerShell **as Administrator** in the unzipped folder and run:
   ```
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
3. This installs the agent as a Windows service, running under its own
   restricted account — not an administrator account. It does not start
   automatically; you'll start it in step 8.

To uninstall later: `powershell -ExecutionPolicy Bypass -File uninstall.ps1`
(add `-Purge` to also remove the agent's stored configuration).

> **To be confirmed on Windows:** the exact install experience, including
> any Windows Defender/SmartScreen prompt on first run (the agent's
> executable is not yet code-signed), has not been verified on a real
> Windows machine as of this writing.

### Linux

1. Copy the bundle (`nia-agent-linux-<version>.tar.gz`) to the target
   machine.
2. Run, as root:
   ```
   sudo ./install.sh nia-agent-linux-<version>.tar.gz
   ```
3. This creates a dedicated, unprivileged system account for the agent
   and installs it as a `systemd` service. It does not start
   automatically; you'll start it in step 8.

To uninstall later: `sudo ./uninstall.sh` (add `--purge` to also remove
the agent's stored configuration).

### macOS (Apple Silicon only)

1. Copy the zip bundle (`nia-agent-macos-arm64-<version>.zip`) to the
   target Mac and unzip it.
2. Open Terminal in the unzipped folder and run:
   ```
   ./install.sh
   ```
   This installs the agent as a per-user `launchd` service, under your
   own macOS user account (no administrator rights needed). It starts
   immediately, and is set to start again at every login and to restart
   itself if it ever stops unexpectedly — unlike Windows/Linux above,
   there is no separate "start the agent" step.

   To instead run it as a system-wide service that starts at boot for
   every user (needs an administrator):
   ```
   sudo ./install.sh --system
   ```

   Settings and encrypted secrets are stored under
   `~/Library/Application Support/NiaAgent` (owner-only permissions);
   logs are stored under `~/Library/Logs/NiaAgent`. (For a `--system`
   install, both move to the matching `/Library/...` paths and are
   owned by root.)

   > **Security warning — unsigned build.** This build is only ad-hoc
   > signed (enough to run on the machine it was built on), **not**
   > signed with an Apple Developer ID. On any other Mac, Gatekeeper
   > will refuse to run it with a message like *"nia-agent" cannot be
   > opened because the developer cannot be verified* or *is damaged
   > and can't be opened*. To run it anyway for testing: open **System
   > Settings → Privacy & Security**, scroll to the Security section
   > after the first blocked attempt, and click **Open Anyway** next to
   > the agent — or run `xattr -d com.apple.quarantine ./nia-agent`
   > before installing, if the quarantine flag is what's blocking it.
   > **A build for customers needs real Developer ID signing and Apple
   > notarization — neither has been done yet, so do not send this
   > unsigned build to a customer.**

To uninstall later: `./uninstall.sh` (or `sudo ./uninstall.sh --system`
for a system-wide install; add `--purge` to also remove the agent's
stored configuration and logs).

## 5. Pair the agent with Nia Core

Pairing links this installed agent to your Nia Core account. Nia Core
will show you a one-time pairing code and the platform address to use.
Run:

```
nia-agent pair --code <pairing-code> --url <platform-address>
```

On success the agent prints the agent ID it was given. From this point
on, the agent checks in with Nia Core on its own; it does not need to be
paired again unless you deliberately unpair it.

To remove the link later (for example, before decommissioning the
machine): `nia-agent unpair`. This does not touch any database
connection or job you've configured — it only removes the agent's link
to Nia Core.

## 6. Add a database connection

Once the readonly login exists (step 3), register it with the agent:

```
nia-agent connection add \
  --id <short-id> --label "<friendly name>" \
  --host <database-server-host> --port <port> --database <database-name> \
  --user nia_agent --password <the-password-from-step-3> \
  --source-timezone <IANA time zone, e.g. America/New_York>
```

- `--source-timezone` must be an IANA time zone name — this tells the
  agent what time zone date/time columns in this database should be read
  as. Use the time zone the database server itself runs in.
- The password is encrypted immediately; it is never stored in plain
  text.
- If your database only accepts unencrypted connections on your local
  network, add `--encrypt false`. Only use `--allow-legacy-tls true` if
  your DBA has confirmed the server cannot negotiate a modern TLS
  version — this is explicitly less secure and should only be used on a
  private, trusted network.

Confirm it works:
```
nia-agent connection test <short-id>
```
A failure here is almost always a network, host/port, or credentials
problem — fix it before moving on.

## 7. Allow destinations

If any of your jobs will be set up and published from Nia Core's
workflow canvas (rather than entered directly on this machine), the
agent will only deliver to a destination address you've explicitly
allowed. Add each one before the workflow is published:

```
nia-agent destinations allow <destination-hostname>
```

Use `nia-agent destinations list` to see everything currently allowed,
and `nia-agent destinations remove <destination-hostname>` to take one
off the list. Jobs you create directly on this machine with `nia-agent
job add` are not affected by this list.

## 8. Start the agent

- **Windows:** `Start-Service nia-agent` (or restart the machine — the
  service is already registered to start automatically going forward).
- **Linux:** `sudo systemctl start nia-agent`
- **macOS:** nothing to do — `install.sh` already started it (see step 4).

## 9. Check status

```
nia-agent status
```

This reports how long the agent has been running, whether it is paired,
when it last checked in with Nia Core, and — once jobs exist — the
health of each one. Run it any time to confirm the agent is alive and
healthy.

## See also
- `docs/pilot/runbook.md` — what each job status and error means, and
  what to do about it.
- `docs/pilot/what-leaves-your-network.md` — exactly what data goes
  where, and what never leaves this machine.
- `docs/pilot/shaping-data-for-planometry.md` — for your DBAs, how to
  shape database tables/views for Planometry.
