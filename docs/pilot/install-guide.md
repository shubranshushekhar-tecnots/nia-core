# Nia Core Agent — install guide

Audience: your IT team. The Nia Core Agent is a small program that runs on a
machine inside your network. It reads from one or more of your databases
and sends rows out to a destination you choose — either straight to
Planometry (or another HTTPS address you control), or as part of a
workflow you built in Nia Core. It never writes to your database, never
makes any inbound network connection, and only needs outbound HTTPS
access.

## What the machine needs

- A Windows, Linux, or macOS (Apple Silicon) machine the agent can run on
  continuously (a small server or VM is fine — it is not
  resource-intensive).
- Network access from that machine to your database.
- Outbound HTTPS access only — two addresses: the Nia Core platform
  address (for pairing/check-ins) and wherever your data is actually sent
  (Planometry, or an address of your own). Nia will give you both. No
  inbound ports need to be opened.
- A read-only login to your database for the agent to use — the guided
  setup below can generate the script for your DBA to create one, if you
  don't have one yet.

## Install

Nia will give you a download link. Pick your OS below — each one ends
with a short, guided setup that asks a few questions (pairing code,
database details) and gets the agent fully working. No typed commands
needed for a normal install.

### Windows

1. Download and double-click **`NiaCoreAgent-Setup-<version>.exe`**.
2. Approve the single admin prompt, choose an install folder (or accept
   the default), and click through to **Finish**. Leave **"Set up now"**
   checked.
3. The guided setup opens automatically in a console window — answer its
   questions (see [below](#guided-setup-questions)).

That's it — the agent is installed as a Windows service (running under
its own restricted account, not an administrator) and starts
automatically from then on. Find **"Nia Core Agent"** in the Start Menu
any time you want to open the agent's own screen (status, connections,
logs). **"Nia Core Agent (advanced) - Setup"** and **"Nia Core Agent
(advanced) - Status"** are also there if you need to re-run the wizard
or check in from the command line. To uninstall, use **Settings → Apps →
Nia Core Agent → Uninstall** — it asks whether to keep or delete the
agent's stored configuration.

> **To be confirmed on Windows:** the exact install experience, including
> any Windows Defender/SmartScreen prompt on first run (the installer is
> not yet code-signed), has not been verified on a real Windows machine
> as of this writing.

### macOS (Apple Silicon only)

1. Download and unzip **`nia-agent-macos-arm64-<version>.zip`**.
2. Open Terminal in the unzipped folder and run `./install.sh`.
3. When it asks **"Run guided setup now? [Y/n]"**, press Enter and answer
   its questions (see [below](#guided-setup-questions)).

That's it — the agent runs under your own macOS user account (no
administrator rights needed), starts immediately, and restarts itself at
login or if it ever stops unexpectedly. Open the agent's own screen any
time with `./nia-agent open` (installed to the folder `install.sh`
printed at the end).

> **Security warning — unsigned build.** This build is only ad-hoc
> signed, **not** signed with an Apple Developer ID. On any other Mac,
> Gatekeeper will refuse to run it (*"nia-agent" cannot be opened because
> the developer cannot be verified*). To run it anyway for testing: open
> **System Settings → Privacy & Security** after the first blocked
> attempt and click **Open Anyway**, or run
> `xattr -d com.apple.quarantine ./nia-agent` before installing.
> **A build for customers needs real Developer ID signing and Apple
> notarization — neither has been done yet; do not send this unsigned
> build to a customer.**

To uninstall: `./uninstall.sh` (add `--purge` to also remove stored
configuration and logs).

### Linux

1. Download **`nia-agent-linux-<version>.tar.gz`** onto the target
   machine.
2. Run, as root: `sudo ./install.sh nia-agent-linux-<version>.tar.gz`
3. When it asks **"Run guided setup now? [Y/n]"**, press Enter and answer
   its questions (see [below](#guided-setup-questions)).

That's it — the agent runs under a dedicated, unprivileged system account
as a `systemd` service, starting automatically going forward.

To uninstall: `sudo ./uninstall.sh` (add `--purge` to also remove stored
configuration).

## Guided setup questions

Whichever OS you're on, the wizard (`nia-agent setup`) asks the same
things, roughly in this order:

1. **Pairing command or code** — paste the full pairing command from your
   Agents page, or just the code; it only asks for the platform address
   separately if you pasted a bare code. Skipped if already paired.
2. **Database server** (default `localhost`) and **Port** (default
   `1433`). On Windows, if the server is local, it detects SQL Server
   instances on the machine and lets you pick one by number.
3. **Database username** — leave blank if you don't have one yet, and it
   offers to write a readonly-setup SQL script for your DBA instead
   (asking for a login name, the database name(s), and where to save it),
   then exits so you can re-run setup once you have credentials.
4. **Database password** (hidden as you type). On a failed login it
   explains why in plain English and asks only for username/password
   again — not server/port.
5. A numbered list of **databases this login can see** — pick one.
6. **Time zone this database server runs in** (defaults to this
   machine's own time zone).
7. **Destination hostname to allow** (optional, repeatable; only needed
   if a job will be published from Nia Core's workflow canvas rather than
   added directly on this machine). Leave blank to finish.

It then starts/confirms the service, waits for a successful check-in,
and prints a summary. Run `nia-agent setup` again any time — once
already set up, it shows a small menu instead (add another database,
test a database, allow a destination, show status, exit).

## Advanced: typed-command install

Everything the guided setup does can also be done by hand — useful for
scripted/unattended installs or if you'd rather not use the wizard.

### Generate the read-only database login directly

```
nia-agent sql readonly --login nia_agent --databases <your-database-name> --out nia-readonly-setup.sql
```

Use a comma-separated list for `--databases` if the agent will read more
than one database on the same server. This writes a script for a DBA to
review and run themselves (the agent never runs it): it creates one
login with a placeholder password the DBA replaces, grants it read access
to the listed database(s) plus the ability to see table/column
definitions, and **grants no write access of any kind** — enforced
automatically. Safe to run more than once.

Optional flags:
- `--schema <name>` — restrict to one schema instead of the whole
  database.
- `--with-cancel-visibility true` — one additional, still read-only,
  permission letting the agent confirm a stopped query actually stopped.
  Off by default.

### Install without the guided setup

- **Windows:** `powershell -ExecutionPolicy Bypass -File install.ps1`
  from the unzipped bundle folder, run as Administrator. Does not start
  automatically — see "Start the agent" below.
- **Linux:** `sudo ./install.sh nia-agent-linux-<version>.tar.gz`. Does
  not start automatically — see "Start the agent" below.
- **macOS:** `./install.sh` (or `sudo ./install.sh --system` for a
  system-wide service for all users, starting at boot). Starts
  immediately either way.

When `install.sh`/`install.ps1` is run non-interactively (stdin isn't a
terminal — e.g. from a provisioning script), the guided-setup prompt is
skipped automatically and the commands below are printed instead.

### Pair the agent

```
nia-agent pair --code <pairing-code> --url <platform-address>
```

Prints the agent ID on success. To remove the link later:
`nia-agent unpair` (does not touch any database connection or job).

### Add a database connection

```
nia-agent connection add \
  --id <short-id> --label "<friendly name>" \
  --host <database-server-host> --port <port> --database <database-name> \
  --user nia_agent --password <the-password> \
  --source-timezone <IANA time zone, e.g. America/New_York>
```

- `--source-timezone` must be an IANA time zone name — the time zone the
  database server itself runs in.
- The password is encrypted immediately; never stored in plain text.
- If your database only accepts unencrypted connections on your local
  network, add `--encrypt false`. Only use `--allow-legacy-tls true` if
  your DBA has confirmed the server cannot negotiate a modern TLS
  version.

Confirm it works: `nia-agent connection test <short-id>`. A failure here
is almost always a network, host/port, or credentials problem.

### Allow destinations

```
nia-agent destinations allow <destination-hostname>
```

`nia-agent destinations list` shows everything allowed;
`nia-agent destinations remove <destination-hostname>` takes one off.
Jobs created directly on this machine with `nia-agent job add` aren't
affected by this list.

### Start the agent (if not using the guided setup)

- **Windows:** `Start-Service nia-agent` (or restart the machine — it's
  already registered to start automatically going forward).
- **Linux:** `sudo systemctl start nia-agent`
- **macOS:** nothing to do — `install.sh` already started it.

### Check status

```
nia-agent status
```

Reports how long the agent has been running, whether it is paired, when
it last checked in, and the health of each job. Run it any time.

## See also
- `docs/pilot/runbook.md` — what each job status and error means, and
  what to do about it.
- `docs/pilot/what-leaves-your-network.md` — exactly what data goes
  where, and what never leaves this machine.
- `docs/pilot/shaping-data-for-planometry.md` — for your DBAs, how to
  shape database tables/views for Planometry.
