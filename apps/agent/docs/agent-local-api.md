# Nia Agent local control API

The background service (`nia-agent start`) exposes a small local-only
HTTP API so a desktop app can drive pairing, connection management,
table browsing, and log tailing without shelling out to the CLI and
without ever needing an admin/UAC prompt for normal use. The service
already runs with the access it needs; the app only ever talks to it
over this API.

## Binding, discovery, and auth

- Binds **`127.0.0.1` only** — never `0.0.0.0`. If it can't bind at all
  (see below), the rest of the agent (jobs, scheduler, check-in loop)
  keeps running without the local API rather than crashing `nia-agent
  start`.
- Default port **`57415`**; if taken, tries `+1` through `+9` (ten
  attempts total) before giving up.
- The actual bound port is written to `<dir>/local-api/port.json`
  (`{ "port": 57415, "startedAt": "2026-10-09T12:00:00.000Z" }`) on
  every successful bind — the desktop app reads this file rather than
  assuming the default port.
- Every request must carry `Authorization: Bearer <token>`, where
  `<token>` is the contents of `<dir>/local-api/token` (generated once
  on first start, reused across restarts, compared with
  `crypto.timingSafeEqual`). One exception: `GET /logs/stream` (SSE)
  may instead pass `?token=<token>` as a query parameter, since
  `EventSource` can't set custom headers.
- `<dir>` is the agent's data directory (`defaultHomeDir()` in
  `src/config/paths.ts`): `%ProgramData%\NiaAgent` on Windows,
  `~/Library/Application Support/NiaAgent` on macOS,
  `/etc/nia-agent` on Linux (overridable via `NIA_AGENT_HOME`, used by
  tests). The token and port file live in their own `local-api`
  subfolder of `<dir>` rather than directly in it — see "Token/port
  file permissions (per OS)" below for why.

Missing/wrong token → `401 { "kind": "unauthorized", "message": "..." }`.
Unknown path → `404 { "kind": "notFound", ... }`. Known path, wrong
method → `405 { "kind": "methodNotAllowed", ... }`.

## Browser safety

Even though the API only binds `127.0.0.1`, a malicious web page open
in the same browser could still try to reach it directly (DNS
rebinding) or via a cross-origin `fetch`. Three defenses, all enforced
in `router.ts` before any route handler runs:

- **Host header validation (DNS rebinding defense).** Every request's
  `Host` header must name `127.0.0.1` or `localhost` on the *actual*
  bound port (`req.socket.localPort`), not just any port. A request
  with a different hostname (e.g. a rebound DNS name resolving to
  `127.0.0.1`) or a mismatched port is rejected with
  `403 { "kind": "forbidden", "message": "..." }` before the body is
  even read.
- **No CORS headers, ever.** The server never sets
  `Access-Control-Allow-Origin` (or any other `Access-Control-*`
  header), so no cross-origin page's `fetch`/`XMLHttpRequest` can read
  a response even if it could get one through.
- **The token is never logged.** `GET /logs/stream`'s `?token=` query
  parameter exists only because `EventSource` can't set headers; the
  request URL (and therefore the token) is never written to
  `agent.log` or anywhere else.

## Rate limiting

`POST /pair` (5 requests/60s) and `POST /connections/test` (20
requests/60s) are rate-limited (fixed window, not IP-keyed — there's
only ever one caller, the desktop app on the same machine). Over the
limit → `429 { "kind": "rateLimited", "message": "too many attempts -- wait a moment and try again" }`.

## Error shape

Every error response is `{ "kind": string, "message": string }`. Known
kinds: `unauthorized` (401), `badRequest` (400), `notFound` (404),
`rateLimited` (429), `inUse` (409, deleting a connection a job still
references), `pairingRejected` (400), `internal` (500 — used for both
unexpected exceptions and deliberately generic messages, so a raw
driver/stack message that might contain a password never reaches the
response body).

## Endpoints

### `GET /status`
Paired state, derived online/offline, job summary.
```json
{
  "paired": true,
  "platformUrl": "https://app.nia.dev",
  "agentId": "agt_abc123",
  "online": true,
  "lastCheckInAt": "2026-10-09T12:00:00.000Z",
  "revoked": false,
  "agentVersion": "0.0.6",
  "startedAt": "2026-10-09T11:55:00.000Z",
  "uptimeSeconds": 300,
  "jobs": []
}
```
Unpaired agents return `{ "paired": false, "agentVersion": ..., "startedAt": ..., "uptimeSeconds": ..., "jobs": [] }`.

### `POST /pair`
Body: `{ "code": "<pairingCodeId>.<code>" | "nia-agent pair --code ... --url ...", "url"?: "https://..." }`.
Accepts either a bare composite code or a full pasted pairing command
(same parser as the CLI wizard); an explicit `url` in the body wins
over one embedded in a pasted command. Rate-limited.
```json
{ "agentId": "agt_abc123" }
```

### `GET /servers`
Windows SQL Server instance discovery, read from the Windows registry
(empty off-Windows).
```json
{ "instances": [{ "name": "SQLEXPRESS", "port": 1433 }] }
```

### `POST /connections/test`
Body: `{ "host", "user", "password", "instanceName"?, "port"?, "encrypt"?, "trustServerCertificate"?, "allowLegacyTls"?, "pickedInstanceLoginMode"? }`.
Same auto-TLS-retry logic as the setup wizard (`testSqlLoginWithAutoRetry`).
Rate-limited.
```json
{
  "ok": true,
  "databases": ["master", "nia_extract_test"],
  "autoTrustedCertificate": false,
  "autoAllowedLegacyTls": false
}
```

### `GET /databases?connectionId=<id>`
Saved-connection only — a connection id is an opaque reference, never a
credential, so it's fine in a URL. Raw credentials must never travel
in a URL (query strings end up in proxy/server logs and browser
history) — use `POST /databases/list` below for those instead. Missing
`connectionId` → `400 { "kind": "badRequest", ... }`.
```json
{ "ok": true, "databases": ["master", "nia_extract_test"] }
```

### `POST /databases/list`
Raw-credentials counterpart to the GET above. Body:
`{ "host", "user", "password", "instanceName"?, "port"?, "encrypt"?, "trustServerCertificate"?, "allowLegacyTls"? }`.
Credentials travel in the body, never in a URL/query string.
Rate-limited (separate budget from `POST /connections/test`).
```json
{ "ok": true, "databases": ["master", "nia_extract_test"] }
```

### `POST /connections`
Body: `{ "id", "label", "host", "database", "user", "password", "sourceTimeZone", "port"?, "instanceName"?, "encrypt"?, "allowLegacyTls"?, "trustServerCertificate"? }`.
Saves the connection; password is written to the encrypted secret
store, never to `agent.config.json`.
```json
{
  "id": "conn-1",
  "label": "Prod SQL",
  "credentialRef": "connection:conn-1",
  "sqlserver": { "host": "localhost", "port": 14330, "encrypt": true }
}
```

### `GET /connections`
```json
{ "connections": [{ "id": "conn-1", "label": "Prod SQL", "credentialRef": "connection:conn-1", "sqlserver": { "host": "localhost" } }] }
```
Never includes the password — only `credentialRef`.

### `DELETE /connections/:id`
```json
{ "removed": true }
```
409 `{ "kind": "inUse", ... }` if a job still references it.

### `GET /connections/:id/tables`
```json
{ "tables": [{ "schema": "dbo", "name": "widgets", "kind": "table", "rowCount": 10000 }] }
```

### `GET /connections/:id/tables/:table/columns`
`:table` is `schema.table` (e.g. `dbo.widgets`); unresolvable names → 404.
```json
{ "columns": [{ "name": "id", "type": "int", "nullable": false }] }
```

### `GET /connections/:id/tables/:table/preview?limit=50`
`limit` is hard-clamped to 50 regardless of what's requested.
```json
{ "columns": [...], "rows": [{ "id": 1, "name": "Widget A" }] }
```

### `GET /destinations`, `POST /destinations { "host" }`, `DELETE /destinations/:host`
Thin wrapper around the existing destination allow-list.
```json
{ "hosts": ["warehouse.example.com"] }
```

### `GET /logs?level=&search=&since=`
In-memory filter over the parsed `agent.log` lines.
```json
{ "entries": [{ "ts": "2026-10-09T12:00:00.000Z", "level": "info", "event": "agent_started" }] }
```

### `GET /logs/stream?token=<token>`
SSE, one `data: <json-line>` event per new log line (poll-based tail,
500ms interval — `fs.watch` is unreliable cross-platform). Requires
`text/event-stream` handling on the client; auth via `?token=` since
`EventSource` can't set headers.

### `GET /diagnostics`
Version, platform, status, and every non-secret config field.
```json
{
  "agentVersion": "0.0.6",
  "platform": "darwin",
  "status": { "startedAt": "...", "uptimeSeconds": 300, "jobs": [] },
  "config": {
    "connections": [{ "id": "conn-1", "credentialRef": "connection:conn-1" }],
    "jobs": [],
    "destinations": ["warehouse.example.com"],
    "link": { "platformUrl": "https://app.nia.dev", "agentId": "agt_abc123" }
  },
  "logs": ["{\"ts\":\"...\",\"level\":\"info\",\"event\":\"agent_started\"}"]
}
```
The secret store is never opened by this route — `config.connections`
only ever carries `credentialRef`, `config.jobs` only `pushKeyRef`,
and `config.link` is reduced to `platformUrl`/`agentId` (no key
reference at all).

## Token/port file permissions (per OS)

The rest of the data directory (`config.json`, `master.key`, the spool,
logs) is locked to the service account alone — on Windows that's `NT
SERVICE\nia-agent` + the built-in Administrators group, nothing else.
That's *not* enough for the local API's token and port files: a
desktop app normally runs as a regular, non-elevated process, even
under an Administrator account. On Windows, an elevated process's
Administrators membership is UAC-filtered (deny-only) in a
non-elevated token, so granting access to "Administrators" alone would
still force the desktop app to show a UAC prompt just to read its own
agent's token — exactly what this split avoids. The fix: the token and
port files live in their own subfolder, `<dir>/local-api/`, with a
wider ACL than the rest of the data directory — service + Administrators
(full control, same as everywhere else) **plus** the specific user who
ran the installer (read-only), identified by SID/account name, not by
group membership:

- **Windows** (`install.ps1`, Step c2, run once at install time):
  ```powershell
  $installingUserSid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User
  $LocalApiDir = Join-Path $DataDir "local-api"
  New-Item -ItemType Directory -Force -Path $LocalApiDir | Out-Null
  $acl = Get-Acl $LocalApiDir
  $acl.SetAccessRuleProtection($true, $false)   # remove inherited rules
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($serviceSid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($administratorsSid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($installingUserSid, "ReadAndExecute", "ContainerInherit,ObjectInherit", "None", "Allow")))
  Set-Acl $LocalApiDir $acl
  ```
  The equivalent as a one-line `icacls` command (what `agent doctor`'s
  fix-it hint shows, and what you'd run by hand to repair a widened
  ACL):
  ```
  icacls "C:\ProgramData\NiaAgent\local-api" /inheritance:r /grant:r "NT SERVICE\nia-agent:(OI)(CI)F" "BUILTIN\Administrators:(OI)(CI)F" "<DOMAIN>\<user>:(OI)(CI)RX"
  ```
  The installer also records the resolved `DOMAIN\user` (or local
  `user`) account name in `<dir>/local-api/installing-user.json`
  (`{ "identity": "CONTOSO\\jdoe" }`) so `nia-agent doctor`'s
  permission check (`checkPathPermissions`, via
  `loadLocalApiExtraAllowedIdentities`) knows that third identity is
  expected on this one subfolder — any *other* identity (most
  importantly `NT AUTHORITY\SYSTEM`, in case the service ever silently
  reverts to LocalSystem) is still flagged as a warning.
- **macOS**: a per-user install (`./install.sh`, no `--system`) runs
  the launchd service as the same logged-in user who ran the
  installer — no split needed, plain `chmod 700` on `local-api/` (like
  the rest of the data dir) already means the token is readable by the
  only account that needs it. A `--system` install (`sudo ./install.sh
  --system`) runs the service as root, so `install.sh` additionally
  grants the installing (non-root) user a read-only NFSv4 ACE on
  `local-api/` via the user recorded in `$SUDO_USER`:
  ```sh
  chmod +a "$SUDO_USER allow read,readattr,execute,search,file_inherit,directory_inherit" "$HOME_DIR/local-api"
  ```
  If `SUDO_USER` is unset (e.g. run via a non-`sudo` root shell),
  `install.sh` warns and prints that same command for the operator to
  run by hand with the correct username.
- **Linux**: `/etc/nia-agent`, owned by a dedicated `nia-agent` user,
  `0700`; the CLI is always invoked via `sudo -u nia-agent` — service
  and CLI already run as the same account, so no split is needed here;
  plain `0700`/`0600` (same pattern as `master.key`) is sufficient.
- **Known accepted gap** (already true of `master.key` today): running
  unpacked straight from source/zip without the installer gives no
  extra ACL beyond the OS default on the data directory's parent.
- **Manual test (Windows only, not automated)**: because this
  specifically guards against a UAC-filtered non-elevated token, it
  can only be verified meaningfully on a real Windows machine, not in
  CI. After running `install.ps1` (elevated) as an Administrator
  account: open a **non-elevated** PowerShell/cmd as that same
  account (no "Run as administrator"), then confirm
  `Get-Content "C:\ProgramData\NiaAgent\local-api\token"` succeeds
  (no prompt, no access-denied) while
  `Get-Content "C:\ProgramData\NiaAgent\config.json"` fails with
  access denied from that same non-elevated shell.

## Manual verification

```sh
NIA_AGENT_HOME=/tmp/nia-agent-manual node --experimental-strip-types src/index.ts start
curl -H "Authorization: Bearer $(cat /tmp/nia-agent-manual/local-api/token)" http://127.0.0.1:57415/status
```
