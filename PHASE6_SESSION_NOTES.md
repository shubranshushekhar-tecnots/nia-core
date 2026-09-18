# Phase 6 Session Notes

## Block 1 — Housekeeping: the chaining contract (runner's written contract)

Per the Phase 6 kickoff's ledger item 1a-3: this moves the multi-transform
pushdown chaining contract out of `af00263`'s commit message (Phase 6 Block
0) into a durable, citable doc — the ETL runner (Block 3) must follow this
contract exactly, not re-derive it from a commit message.

**What composes in-dialect vs. what forces residual, precisely:**

`compilePushdown()` (`packages/schemas/src/pushdown.ts`) compiles exactly
ONE node's `TransformConfig` against one source dialect. It walks that
node's `steps` in array order and pushes each step into the compiled
dialect query for as long as the step is pushable
(`isPushable()` — dialect-specific: SQL/Mongo each support a different
subset of `TransformStep` kinds). The **first non-pushable step, and every
step after it in that same node**, becomes residual in-stream work — never
reordered around, since reordering user-authored steps to keep pushing
down would silently change semantics (a later step could in principle be
pushable on its own, but this compiler will not skip ahead to push it).

That single-node contract does NOT extend across multiple transform nodes
on one source→destination path. `compilePushdown()` takes one
`TransformConfig`, not a path — there is no defined way today to chain two
transform nodes' compiled fragments into one dialect query. Phase 5
Session 5 Block 1 (preview) hit this first and resolved it by degrading
honestly rather than inventing chaining semantics under that session's
scope:

- **0 transform nodes** on the path → trivial; no pushdown needed beyond
  the mapping's own projection.
- **Exactly 1 transform node** → normal `compilePushdown()`, single-node
  contract above applies in full.
- **2+ transform nodes** → the ENTIRE path's transforms are treated as
  residual — nothing is pushed down, no `WHERE`/pipeline fragment is
  compiled at all, even if the first node's steps would individually have
  been pushable. `PreviewValue.residualCount` (and the runner's equivalent
  reporting) must report the true residual count so the UI's "N in-stream
  transforms will apply at run time" notice is never misleading about what
  actually executed.

**The runner's obligation (Block 3):** `EtlRunJob`'s "apply residual
transforms in-stream" step must implement this exact same 0/1/2+ split —
resolve the entity first (`entityResolution.ts`), call `compilePushdown()`
for the single-node case, and fall back to fully-residual, in-process
transform application for any path with 2+ transform nodes. This is not a
gap to close inside Block 3; multi-transform pushdown chaining remains
explicitly out of scope (Phase 5 Session 5's decision, reaffirmed at Phase
6 Block 0 — see `TODO.md`'s closed compiler-completeness entry and
`af00263`'s commit message) — the runner only needs to implement the
residual fallback correctly, not build real chaining.

See `packages/schemas/src/pushdown.ts`'s header comment (dialect/fragment
scope) and `PHASE5_SESSION_NOTES.md`'s Session 5 Block 1 entry (original
preview-side discovery and the 0/1/2+ degradation this contract
generalizes from).

## Block 3.5, item 7 — `0016_write_grants.sql`, correctly this time

### 7a. Per-RPC SQL verification

Three questions, three RPCs, one line each — all three answer yes,
verified by direct line quotes from `supabase/migrations/0016_write_grants.sql`:

| RPC | `search_path` pinned? | `security definer`? | explicit `revoke ... from public, anon` before `grant ... to authenticated`? |
| --- | --- | --- | --- |
| `create_write_grant(uuid, jsonb)` | Yes — `set search_path = ''` (line 92) | Yes — `security definer` (line 91) | Yes — `revoke execute on function public.create_write_grant(uuid, jsonb) from public, anon;` then `grant execute on function public.create_write_grant(uuid, jsonb) to authenticated;` (lines 131–132) |
| `confirm_write_grant(uuid, text)` | Yes — `set search_path = ''` (line 144) | Yes — `security definer` (line 143) | Yes — `revoke execute on function public.confirm_write_grant(uuid, text) from public, anon;` then `grant execute on function public.confirm_write_grant(uuid, text) to authenticated;` (lines 190–191) |
| `revoke_write_grant(uuid)` | Yes — `set search_path = ''` (line 201) | Yes — `security definer` (line 200) | Yes — `revoke execute on function public.revoke_write_grant(uuid) from public, anon;` then `grant execute on function public.revoke_write_grant(uuid) to authenticated;` (lines 247–248) |

All three RPCs are uniformly hardened (pinned `search_path`, `security
definer`, revoke-then-grant on `execute`). **No follow-up migration is
needed** — nothing to fix, so no STOP-for-review is triggered by this
item.

### 7b. Reconciliation table — `0007_connectors.sql` vs `0016_write_grants.sql`

`0007_connectors.sql` shipped `write_grants` as an unexercised
placeholder: a plain, directly client-writable table with no
grant/confirm/revoke workflow beyond a single `revoked_at` flip.
`0016_write_grants.sql` (this session) turned it into the real two-step
grant → confirm → revoke model described in Block 2's decision entry.

| Column / property | 0007 state | 0016 action |
| --- | --- | --- |
| `id`, `connection_id`, `granted_by_user_id`, `granted_at` | Present, unexercised (no app code ever wrote a row) | Unchanged |
| `scope` (`jsonb default '{}'`) | Present — free-form `{"schemas": [...]}` shape, never validated beyond being jsonb | Unchanged; still set at `create_write_grant` time, still un-validated beyond jsonb-ness |
| `revoked_at` | Present — the only "state" transition the 0007 shape supported (grant is either live or revoked) | Unchanged in column shape, but now settable **only** via `revoke_write_grant`'s soft-delete (`set revoked_at = now() where ... revoked_at is null`, line 226–227) — direct client `UPDATE` is revoked (see RLS row below) |
| `confirmed_at` | **Did not exist** | **New.** Added by this migration; null until `confirm_write_grant` succeeds; `confirm_write_grant` itself guards on `confirmed_at is null and revoked_at is null` (line 170) before setting it, and raises `'write grant % is already confirmed or has been revoked'` otherwise (line 174) — makes confirm deliberately non-idempotent (rotation path is revoke + re-create, per the migration's header comment, not re-confirm) |
| `cred_version` | **Did not exist** | **New**, `integer not null default 1` — versions the credential material backing a grant so a rotated credential can be distinguished from the original without changing `id` |
| `write_credential_vault_ref` | **Did not exist** | **New**, `text` — set at confirm time (`confirm_write_grant(p_grant_id, p_write_credential_vault_ref)`), points at the vault-stored write credential; null until confirmed, matching `confirmed_at`'s null-until-confirmed lifecycle |
| Direct client `INSERT`/`UPDATE` (RLS policies `write_grants_insert_members` / `write_grants_update_members`) | Present in 0007 — any workspace member could mint or edit a grant row directly via a bare PostgREST call | **Dropped.** Both policies removed; direct `insert, update` also `revoke`d from `authenticated` at the table-grant layer (line 82) — RPC-only from here on, same "forgeable gate" pattern already applied to `workflow_check_runs` (0014) |
| Direct client `SELECT` (`write_grants_select_members`) | Present in 0007 | **Unchanged** — reads still flow through the original member-scoped RLS policy; only writes were locked down |
| RBAC (admin/owner gating) | None — all-role by omission (0007 predates `can.ts`'s capability matrix) | **Still none, explicitly** — all three RPCs stay all-role by design, matching the already-documented DECISION-C ruling (`docs/decisions.md`): work actions (including minting/confirming/revoking write grants) are not admin/owner-gated, only org-governance actions are |
| Deprecated-but-kept columns | — | None. Every 0007 column survives unchanged in shape; 0016 is purely additive (3 new columns) plus a write-path lockdown — no column was kept-but-deprecated |

## Block 4 correction to the Block 2 report: grant-creation UI was never built

Block 2's report (commit `ecbc225`) listed "NodeDrawer.tsx /
connectionsClient.ts: UI unlock for confirming/revoking write grants"
as delivered work. Discovered while building Block 4's E2E test: that
line describes only the **read side** — `NodeDrawer.tsx`'s
`SourceDestForm` queries `getWriteGrants()` to lock/unlock write verbs.
No component anywhere in `apps/web` actually **creates** or **confirms**
a grant: there is no UI calling `create_write_grant`/`confirm_write_grant`,
no generated `CREATE ROLE`/`GRANT` SQL text, and no write-credential
input field, despite Block 2's kickoff spec asking for exactly that.
`connectionsClient.ts` has only `getWriteGrants()` — no
`createWriteGrant`/`confirmWriteGrant`/`revokeWriteGrant` wrappers exist
even though the REST routes they'd call (`apps/api/src/routes/grants.ts`)
are fully implemented. `ConnectionsClient.tsx`'s own comment already
conceded this ("Write-grants (mint/revoke) are deliberately not
surfaced here yet, per the fixed Step 5 scope") — the Block 2 report
should have said "confirming/revoking" was itself unimplemented in the
UI, not just unlock display.

Not fixed in Block 4 (a proof block, not new UI surface) — see
`docs/decisions.md`'s matching correction entry. The E2E test drives
grant creation/confirmation via direct RPC calls (the `write-smoke.ts`
pattern) and only exercises real UI for the read side (verb lock/unlock,
`checkGrants` pass/fail) and everything downstream of a confirmed grant.
The grant-creation UI itself is now explicitly scoped into **Block 5
(write-path generalization)**.

## Block 5: grant-creation UI shipped (Block 4's remaining proof work deferred)

Per user direction, Block 4's two remaining proof artifacts (the
Playwright E2E for the grant/run/status flow, and the 1,000,000-row
kill -9 resilience test — `apps/worker/scripts/kill-test.ts`, already
written but not yet run) were explicitly deferred to prioritize real
product surface. Block 5 built the grant-creation UI Block 2 never
shipped:

- `packages/schemas/src/writeGrantStatement.ts` — pure `buildGrantStatementText(connectorId, namespace, roleUser, rolePassword)`, dialect-switched (postgres/mysql/mongodb `CREATE ROLE`/`CREATE USER`/`createUser` + grant text). Generates correct text for all three connectors even though only `supabase` is a real `etl_sink` today — see the file's header comment.
- `apps/api/src/services/grants.ts`'s `confirmWriteGrant` now takes the raw `{ user, password }` credential (not a pre-existing vault ref) and writes it to Vault itself via `create_connector_secret`, mirroring `connections.ts`'s `createConnection` pattern — the browser never talks to Vault directly. `routes/grants.ts`'s confirm body schema updated to match.
- `connectionsClient.ts` gained `createWriteGrant`/`confirmWriteGrant`/`revokeWriteGrant` wrappers (previously only `getWriteGrants` existed).
- `NodeDrawer.tsx`'s `SourceDestForm` (destination nodes) renders a new `GrantAccessPanel` under the table picker whenever a namespace is selected and not yet covered by a confirmed grant: generates a role user/password client-side, mints the grant, shows copy-ready statement text, and confirms with that same credential on click — resumes at the confirm step instead of re-minting if an unconfirmed grant for that namespace already exists.

Not done: actual mysql/mongodb write dispatch (both stay read-only
connectors; the statement generator covers their dialect syntax only, not
real execution), a revoke-from-the-UI affordance, and Block 4's two proof
artifacts above. Not yet verified live (no browser session run this
pass) — typecheck is clean across `@nia/schemas`/`@nia/api`/`@nia/web`.
