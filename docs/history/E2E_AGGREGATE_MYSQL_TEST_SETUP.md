# Setup: two hand-verifiable ETL tests (Supabase → Aggregate → MySQL)

This is a setup document only — nothing in this repo was run to produce it, and you build/run both tests yourself in the browser. Everything below was verified by reading the actual current source (file:line references included) so field names, host values, and write-mode behavior match what's really in the code, not convention.

**Read the two flagged findings below before you start** — both change the click-by-click steps in ways you wouldn't guess from the UI alone.

---

## Flagged finding #1 — Step 1's scope needs your confirmation

"The connected Supabase project" in your brief is ambiguous between two very different things:

- **(a)** a separate Supabase project you'll wire up purely as ETL source data for this test, or
- **(b)** the same Supabase project that backs nia-core's own app (auth, orgs, workflows, connections — everything under `apps/api`/`apps/web`).

I've assumed **(a)**. If you actually mean (b): **do not run Step 1's DROP block.** That project's `public` schema currently holds 14 app-infra tables (`profiles`, `organizations`, `organization_members`, `audit_log`, `projects`, `workflows`, `workflow_runs`, `connector_installs`, `connections`, `write_grants`, `conversations`, `messages`, `workflow_graphs`, `workflow_check_runs` — enumerated from all 19 files in `supabase/migrations/`). Dropping those would wipe your org, connections, and every workflow you've built, including whichever workflow you use to run this very test. It is safe to the *app itself* (no server code queries specific rows at startup — every query is request-scoped and RLS-gated, confirmed in `apps/api/src/index.ts`, `apps/worker/src/index.ts`), but it is **not** safe to your own account's data.

The DROP block below is written as a dynamic loop (drops whatever tables actually exist in `public`, not a hardcoded list) specifically so it's correct either way — but the decision of *which* project to point it at is yours. Run the SELECT first and eyeball the output before running the DROP.

## Flagged finding #2 — the in-app destination "Preview" button is broken for Aggregate output, and the field-mapping dropdown can't reference aggregate output fields at all without a small workaround

Both are real, narrow gaps in the current code, not something you're doing wrong:

1. **Preview will error, not just "not prove the write."** `apps/worker/src/lib/preview/runPreview.ts`'s `buildPreviewQuery` (lines 117–137) never reads `dialectQuery.groupBySql`/`havingSql` — it only splices `selectSql` and `whereSql`, so an Aggregate-fed preview compiles a query with the right `SELECT COUNT(*) AS order_count, SUM(amount) AS total_amount` expressions but **no `GROUP BY`**, prefixed by the raw field-mapping columns. Since those mapping columns end up literally being `` `order_count` AS `order_count` `` (see next point — the mapping "from" side has to be aliases, which aren't real source columns), MySQL will reject the query outright (`Unknown column 'order_count' in field list`) before it ever reaches the aggregate part. The **real run path is fine** — `apps/worker/src/lib/etl/queryBuilder.ts`'s `buildEtlReadQuery` (lines 67–74) correctly emits `GROUP BY`/`HAVING`. Only the one-off Preview button is affected. **Skip Preview for both tests** — Step 6 below gives you the real verification route.

2. **The Field Mapping "from" dropdown only ever lists raw introspected source columns**, never the Aggregate step's own output shape. `MappingEditor.tsx`'s `useEntityFields` (line 134) and the server's `proposeMapping.ts` (line 87) both call the connection's raw `/introspect` result — they have no idea a Transform node sits between source and destination, let alone what its `groupBy`/aggregation aliases produce. But the **real write path needs exactly those alias/groupBy names** as the mapping's `from` values (`runEtl.ts` applies `mapping.entries` against the aggregate query's *output* rows, which are shaped `region, order_count, total_amount` — confirmed via `queryBuilder.ts`'s aggregate branch, which selects only `groupBySql`+agg aliases, no `*`). The dropdown (`FieldSelect`, `MappingEditor.tsx:80-118`) is a plain `<select>` with no freeform-typing fallback once the connection has any introspected fields, so there's no click-path to type `order_count` directly.

   **Workaround, fully within the existing product, no devtools needed:** `useEntityFields` unions field names across *every* entity on the connection, not just the one the source node points at. So Step 2 below adds a few extra, never-populated, nullable columns to `orders` — named `order_count`, `total_amount`, `total_qty` — purely so those exact strings appear as selectable options in the mapping dropdown. They're invisible to the real run (the aggregate query never does `SELECT *`), and it's called out inline in the seed SQL so it doesn't get mistaken for real data modeling.

---

## Shared setup (do this once)

### Step 1 — Inspect, then wipe, the Supabase source project's `public` schema

**(a) List what's there — run this first and read the output:**
```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

**(b) Drop everything in `public` (auth/storage/vault/private schemas untouched). Idempotent — safe to re-run, including on an already-empty schema:**
```sql
do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public'
  loop
    execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade';
  end loop;
end $$;
```

### Step 2 — Seed the source data

```sql
create table orders (
  id serial primary key,
  order_date date not null,
  region text not null,
  amount numeric(10,2) not null,
  status text not null,
  -- Shim columns for the app's field-mapping dropdown — see "Flagged finding #2"
  -- above. Never populated, never read by the real ETL run (which SELECTs the
  -- aggregate's own GROUP BY + alias columns, not `orders.*`). They exist only
  -- so "order_count" and "total_amount" are selectable as mapping "from" values.
  order_count int,
  total_amount numeric(10,2)
);

insert into orders (id, order_date, region, amount, status) values
  (1, '2026-01-05', 'north', 100.00, 'paid'),
  (2, '2026-01-06', 'north', 250.50, 'paid'),
  (3, '2026-01-07', 'north',  49.50, 'refunded'),
  (4, '2026-01-05', 'south', 300.00, 'paid'),
  (5, '2026-01-08', 'south', 200.00, 'paid'),
  (6, '2026-01-05', 'east',   75.25, 'paid'),
  (7, '2026-01-06', 'east',  124.75, 'paid'),
  (8, '2026-01-07', 'east',  100.00, 'refunded'),
  (9, '2026-01-09', 'east',  200.00, 'paid'),
  (10, '2026-01-09', 'south',  0.00, 'cancelled');

create table events (
  id serial primary key,
  product_code text not null,
  event_type text not null,
  qty int not null,
  -- Shim column, same reason as orders.order_count/total_amount above.
  total_qty int
);

insert into events (id, product_code, event_type, qty) values
  (1, 'A-100', 'purchase', 30),
  (2, 'A-100', 'purchase', 20),
  (3, 'B-200', 'purchase', 12),
  (4, 'C-300', 'purchase', 40),
  (5, 'C-300', 'purchase', 50),
  (6, 'D-400', 'purchase', 5),
  (7, 'A-100', 'return', 0),
  (8, 'C-300', 'return', 0);
```

`status`/`event_type` stay unused by both transforms on purpose — they exercise the Aggregate step's field checkboxes on columns it should ignore.

In the app, make sure your **Supabase source connection** points at this project and its schema has been (re-)introspected since this SQL ran (opening the source node's Table dropdown triggers this).

### Step 3 — MySQL destination

**Which host to type into the app's connection form — read this before creating the connection.** `connector-mysql` runs as its own Docker container (`docker-compose.yml:12-30`), on the same Docker Compose `default` network as `dev-mysql` (`dev-mysql` declares no `networks:` key, so it also joins the project's implicit `default` network — `docker-compose.yml:67-79`). The MySQL server address you type into the app's connection form is used **verbatim inside that container** (`services/connector-mysql/src/pool-manager.ts:78`, `mysql.createPool({ host, port, ... })`) — it is never resolved from your host machine. So:

- **In the app's connection form:** Host = `dev-mysql`, Port = `3306` (the container's own port — Compose's internal DNS resolves the service name directly; the `3307` host-port remap below is irrelevant here).
- **From your own terminal** (for Step 3's DDL and Step 5's grant SQL): use `127.0.0.1`, port `3307` — that's the host-side remap (`docker-compose.yml:75`), already in place on this machine because a native mysqld already owns 3306 (per project memory).

**Bring up the database and create both destination tables** (root, since the built-in `nia_ro` user is SELECT-only — see `docker/dev-mysql-init.sql:29-31`):

```bash
docker compose up -d dev-mysql
```

```bash
docker compose exec dev-mysql mysql -uroot -pdevroot sandbox
```
(or, if you'd rather use a terminal `mysql` client: `mysql -h127.0.0.1 -P3307 -uroot -pdevroot sandbox`)

```sql
CREATE TABLE region_totals (
  region VARCHAR(50) PRIMARY KEY,
  order_count INT NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL
);

CREATE TABLE product_volume (
  product_code VARCHAR(50) PRIMARY KEY,
  total_qty INT NOT NULL
);
```

**Connection form fields** — exact labels/keys from `packages/schemas/src/connectors/mysql.ts:27-33` and `apps/web/src/components/app/AddConnectionDialog.tsx`:

| Field (label) | Value |
|---|---|
| Name | anything, e.g. `dev-mysql sandbox` |
| Host | `dev-mysql` |
| Port | `3306` |
| Database | `sandbox` |
| Username | `nia_ro` |
| Password | `nia_ro_pw` |

This is the connection's **read-side** credential (used for introspection/preview via `getPool()`). It deliberately does *not* need write privileges — the actual write happens through a separately-minted grant credential (Step 5), never through this one (`pool-manager.ts:96-110`, read and write pools are fully separate, keyed and credentialed independently).

---

## Expected output (compute-by-hand reference)

**Test B** — `GROUP BY product_code, SUM(qty)`, `HAVING SUM(qty) >= 20`:
```
A-100 | 50
C-300 | 90
```
`B-200` (12) and `D-400` (5) must be absent — that's the proof HAVING pushed down.

**Test A** — `GROUP BY region, COUNT(*), SUM(amount)`, no HAVING:
```
east  | 4 | 500.00
north | 3 | 400.00
south | 3 | 500.00
```

---

## Build order note

`operations={manifest?.operations ?? ['read']}` (`NodeDrawer.tsx:539,549`) and the MySQL manifest declares `operations: ["mysql"]` → `["read"]` only (`connectors/mysql.ts:34`). **The destination node's "Verb" selector will only ever show "Read" — there is no insert/update verb to pick or unlock.** That's expected, not a missing grant; ignore it. The actual write happens automatically when you click **Run**, driven entirely by the field mapping + upsert keys + write grant, never by a verb selection.

**Build Test B and Test A as two separate workflows, each with exactly one Source → Aggregate → Destination chain**, not two pipelines on one canvas. Two independent reasons:
1. `handleRun` targets **every** destination node currently on the canvas at once (`FlowCanvas.tsx:441`, `runNodeIds = destinationNodes.map(n => n.id)`) — one shared canvas would fire both tests' writes on a single click.
2. The source entity/table picker doesn't survive a page reload (`canvas.spec.ts:274`, open bug). Building one single-pipeline workflow start-to-finish in one sitting avoids ever needing a reload.

Since both destination tables live in the same MySQL `sandbox` database, one MySQL connection (created once, above) is reusable across both workflows — no need to recreate it per test.

---

## Test B — events → Aggregate (GROUP BY + HAVING) → product_volume

Build a new workflow with a Source node (Supabase, `events` table) → Aggregate transform → Destination node (MySQL).

### Source node
- **Table** dropdown (`NodeDrawer.tsx:410`): select `public.events`.
- No separate column picker exists on the source node itself (`SourceDestConfig` has no `columns` field) — every source column flows through by default; the Aggregate step's own field checkboxes are the closest thing to a column picker, and that's what narrows `event_type` out.

### Transform node (Aggregate)
Click **`+ Aggregate`** (`TransformEditor.tsx:528-539`).
- **Group by** (`TransformEditor.tsx:326`): check `product_code`.
- **Aggregations** (`TransformEditor.tsx:337-377`): click `+ Aggregation`, set function = `sum`, field = `qty`, output name = `total_qty`.
- **Having** (`TransformEditor.tsx:379-430`): click `+ Having condition` — field dropdown only offers groupBy fields + aggregation aliases (`product_code`, `total_qty`) by design (ruling 2, `docs/decisions.md`) — pick `total_qty`, operator `>=`, value `20`.

Optional sanity check: the **Pushdown** panel at the bottom of this node (`TransformEditor.tsx:542-594`) shows the compiled `GROUP BY`/`HAVING` SQL fragment — confirm it reads `GROUP BY "product_code" HAVING (SUM("qty") >= $1)` (or MySQL-quoted equivalent) before moving on. This is the one place you can see the correct pushdown without hitting the broken Preview button.

### Destination node
- **Table** dropdown: select `sandbox.product_volume` (MySQL connection from Step 3).
- Grant panel appears automatically below the Table picker once a table is selected and no grant covers `sandbox` yet (`NodeDrawer.tsx:357-365`, `GrantAccessPanel`):
  1. Click **"Grant write access"** (`NodeDrawer.tsx:230`).
  2. Copy the generated statement (**"Copy statement"**) — it will read:
     ```sql
     -- Run against the target database with an admin credential.
     CREATE USER `nia_write_xxxxxxxx`@'%' IDENTIFIED BY '<random-password>';
     GRANT SELECT, INSERT, UPDATE ON `sandbox`.* TO `nia_write_xxxxxxxx`@'%';
     FLUSH PRIVILEGES;
     ```
     (`writeGrantStatement.ts:73-82`) — note the grant is scoped to the whole `sandbox` database, not just `product_volume`, so it will also cover Test A's `region_totals` table later without re-minting.
  3. Run that exact statement in your MySQL terminal, as root: `docker compose exec dev-mysql mysql -uroot -pdevroot sandbox`.
  4. Back in the app, click **"I've run this — confirm access"**.

- Switch to the **"Field mapping"** tab (`NodeDrawer.tsx:516-525`).
  - Click **"+ Entry"** twice, or use **"Propose mapping"** and then fix it — the LLM suggestion will only match raw column names (`product_code`), so plan to hand-fix `total_qty`:
    - Entry 1: from `product_code` → to `product_code`.
    - Entry 2: from `total_qty` → to `total_qty` (only selectable in the dropdown because of the shim column added in Step 2 — see Flagged finding #2).
  - Click **"Approve"** (`NodeDrawer.tsx:374`) — stays disabled until every entry has both sides filled.
  - **"Upsert keys"** section: check `product_code`. This is the only "write mode" concept that exists in this codebase — there is no append/truncate-load option; every write is an `INSERT ... ON DUPLICATE KEY UPDATE` upsert keyed on whatever you check here (`services/connector-mysql/src/writeSql.ts`, `index.ts:192`). Checking `product_code` (the table's own primary key) is what makes re-running this test idempotent.
  - **Skip "Preview"** — see Flagged finding #2, it will error for this pipeline shape.

### Run
Top of canvas: click **"Run checks"** first, confirm it passes (mapping-approved + DAG checks; note the UI's separate "grants" check is a structural no-op for MySQL/Supabase-style connectors since their `operations` list never contains a write verb — `checks.ts:466-509` — so don't rely on that panel to confirm your grant; the real gate is the `/write` endpoint's own grant re-check at dispatch time, `services/connector-mysql/src/index.ts:184-189`). Then click **"Run"**.

Run status streams live on the canvas per destination node (`FlowCanvas.tsx:400-549`): `starting → running → done` (or `error`/`cancelled`), with a running row-count and, on completion, duration.

---

## Test A — orders → Aggregate (GROUP BY, no HAVING) → region_totals

Build a second, separate workflow the same way.

### Source node
- **Table**: `public.orders`.

### Transform node (Aggregate)
- **Group by**: check `region`.
- **Aggregations**: two entries —
  - function `count`, no field (auto-hidden/`*` for `count`), output name `order_count`.
  - function `sum`, field `amount`, output name `total_amount`.
- **Having**: leave empty (Test A has no HAVING).

### Destination node
- **Table**: `sandbox.region_totals`.
- Grant panel: if you kept Test B's grant active (recommended — it already covers all of `sandbox`), you'll see **"Write access granted to 'sandbox'."** with a **"Revoke access"** button (`RevokeAccessPanel`, `NodeDrawer.tsx:283-312`) instead of the mint flow — nothing to do here.
- **Field mapping**:
  - from `region` → to `region`.
  - from `order_count` → to `order_count` (shim column).
  - from `total_amount` → to `total_amount` (shim column).
  - **Approve**.
  - **Upsert keys**: check `region`.

### Run
Same as Test B: **Run checks** → **Run**, on this workflow.

### Revoke, once both tests are verified
Back on either workflow's destination node, click **"Revoke access"** (`NodeDrawer.tsx:307`). This only flips `revoked_at` on the `write_grants` row and immediately re-locks nothing-to-lock in the UI (recall the Verb selector never showed a write option to begin with) — it does **not** touch the MySQL role/privileges itself. If you want the DB-side role fully gone too, drop it manually: `DROP USER 'nia_write_xxxxxxxx'@'%';` as root.

---

## Verification

**Route (a), in-app Preview — skip it.** Confirmed broken for this pipeline shape (Flagged finding #2). Don't spend time debugging it as if it were your test's fault.

**Route (b), raw MySQL SELECT — this is the real check, use it:**
```bash
docker compose exec dev-mysql mysql -uroot -pdevroot sandbox -e \
  "select * from product_volume order by product_code;"
docker compose exec dev-mysql mysql -uroot -pdevroot sandbox -e \
  "select * from region_totals order by region;"
```
Diff the output against the "Expected output" tables above.

**Run status**, during and after: the canvas UI itself, live-streamed per destination node (`starting/running/done/error/cancelled` with row counts, `FlowCanvas.tsx:400-549`) — no separate page needed.

**Checkpoint state**: not surfaced in the UI as text; it's the `cursor_json` column on `workflow_runs` (`supabase/migrations/0017_run_checkpoints.sql`). Since both tests are single-shot aggregate runs (non-paginated, per `queryBuilder.ts:67-68` — GROUP BY collapses the pagination key), checkpoint state isn't meaningfully exercised here anyway; if you want to look at it directly:
```sql
select id, status, rows_processed, cursor_json
from workflow_runs
where id = '<run id from the canvas activity log>';
```
