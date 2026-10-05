# What leaves your network

Audience: your IT and security team. One page on exactly what the Nia
Agent sends, to whom, and what it never sends — for both ways a job can
be set up.

## The two ways a job can be set up

- **Direct delivery.** A job is created on the agent machine itself and
  points straight at a destination — either Planometry or an HTTPS
  address you control.
- **Through a Nia Core workflow.** A job is designed in Nia Core's
  workflow canvas and published down to the agent to run.

In **both** cases, the agent itself reads your database and sends the
resulting rows **directly to the job's destination** (Planometry or your
HTTPS address) — row data never passes through Nia Core's platform
either way. The difference is only who defines and manages the job:
with a published workflow, Nia Core also receives a summary of how that
job is doing (see below); with a job you created directly on the agent,
Nia Core never sees it unless you publish it.

## What Nia Core's platform receives

Only small, non-sensitive status information, sent when the agent checks
in:

- That the agent is alive, and its version and host name.
- For each job: its name, which database table it reads, where it
  sends to (destination type and host, not the full address with any
  path or query string), its schedule, and its current health (healthy /
  failing / paused).
- For each run: whether it succeeded, how many rows were sent, how long
  it took, and — if it failed — which general category of error it was
  (for example "schema changed" or "network timeout"), never the
  specific error text.

That's it. No row values, no column values, no filter or parameter
values, and no error message text ever appear in this check-in traffic.

## What never leaves your network

- **Your database password.** It's encrypted and stored only on the
  agent machine. It is never sent to Nia Core, never sent to Planometry,
  and never sent to any HTTPS destination.
- **The actual rows, on the direct-delivery route.** When a job delivers
  straight to Planometry or your own HTTPS address, that destination is
  the only place the row data goes — Nia Core's platform never sees it,
  whether or not that job happens to also be visible in Nia Core because
  it was published there.
- Any detailed rejection or error message text from a destination (for
  example, a message Planometry returns if it rejects a batch). Those
  stay in the agent's own local logs and status, for your team's
  troubleshooting — they are deliberately excluded from what's reported
  back to Nia Core.

## How you stay in control

- **The allow-list.** For jobs published from a Nia Core workflow, the
  agent will refuse to deliver anywhere that isn't on a destination
  allow-list you maintain on the agent machine (`nia-agent destinations
  allow/list/remove`). A workflow can't quietly start sending your data
  somewhere new — you decide what's reachable.
- **Unpair.** Running `nia-agent unpair` immediately removes the agent's
  link to Nia Core. The agent keeps running any jobs you set up directly
  on it, but it stops checking in and can no longer receive anything
  published from a workflow.
- **Revoke.** Nia Core can revoke an agent's access from its side at any
  time (for example, if a machine is decommissioned or access needs to
  be cut immediately). A revoked agent is rejected the next time it
  tries to check in.

## See also
- `docs/pilot/install-guide.md` — setup, including the two outbound
  addresses this all depends on.
- `docs/pilot/runbook.md` — job states and error meanings.
