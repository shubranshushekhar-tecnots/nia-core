# Planometry v4 connector migration — plan

Source of truth: `docs/planometry/connector-guide-v4.md` ("the guide" below),
Part A (§1–§8, Option 2, the connector pushes into an **Internal Table** —
the protocol apps/agent targets), and `docs/planometry/mini-nia-core.html`,
the reference client — plain JS, read in full for this plan. Part B (§9–§13,
Option 3, Planometry pulls) is **out of scope** here; see "Later: pull mode"
near the end.

**Citation convention used throughout:** every rule is tagged either
**[guide §N]** (taken directly from the guide, section number given) or
**[agent design — guide silent]** (the guide has nothing to say on the
point; this plan states the default the agent uses, and — only where the
answer must come from Planometry or from GMS's actual database — also adds
the point to one of the two "Open questions" lists at the end). Internal
engineering choices with no external party who could answer them (e.g. "how
many seconds of overlap") are stated as defaults inline and are **not**
duplicated into the open-questions lists, to keep those lists meaningful.

This replaces the previous draft of this file (the guessed work-queue/
catalog-push/chunk/heartbeat protocol in `docs/plans/planometry-integration.md`
Phase 2 is already superseded by the v4 contract and stays there as history).

---

## 1. Change detection, per job

Every job is one SQL Server source (table or view) feeding one Planometry
Internal Table, with one strategy for *change* detection (how it finds rows
to upsert) and, independently, one method for *delete* detection (how it
finds rows that disappeared).

### 1.1 Upsert (watermark)

- **Needs from source:** a watermark column — a date-time column
  (`datetime`/`datetime2`/`smalldatetime`/`datetimeoffset`) whose value
  only increases as a row is modified (e.g. `modified_at`). **This build
  supports date-time watermark columns only** — `rowversion` and
  incrementing-integer-key watermarks are out of scope, not designed here.
  Read via the existing filter builder's `gte`/`gt` operators **[agent
  design — guide silent; packages/extract's filterBuilder already
  supports `gte`/`gt`, confirmed, no new operator needed]**.
- **State kept:** `lastWatermark` (the boundary through which the job has
  successfully pushed). **[agent design]**
- **Where stored:** in the job record inside `agent.config.json`
  (`SyncJobEntry.strategy.lastWatermark`, §9 below) — it is a boundary
  value, not customer row data, so it does not need the encrypted secret
  store or spool-grade encryption. **[agent design]**
- **How `lastWatermark` is computed — the source server's clock, never
  the agent's clock, never the max value seen:** at the start of a run's
  extraction, the agent reads the SQL Server's own clock in that same
  connection (not `Date.now()` on whatever machine the agent runs on), and
  sets the new `lastWatermark` to `(that server-side instant −
  overlapSeconds)` once the run completes. It is never derived from the
  maximum watermark value observed among the extracted rows — a run that
  extracts zero rows still advances `lastWatermark` to the server-clock-
  based boundary, so a quiet period never causes the watermark to stall.
  **[agent design — guide silent on extraction-side windowing entirely,
  since it never sees SQL Server at all.]**
- **Clock-skew check at `job add` / `job test`:** the agent compares the
  watermark column's current `MAX()` value against the source server's own
  clock (read in the same connection); if the column's max value is
  *ahead* of the server's clock, `job test` warns — this usually means the
  column is populated by application-server time rather than database
  time, which breaks the server-clock windowing above. **[agent design —
  guide silent, a SQL Server/extraction detail outside the push
  contract.]**
- **When it advances:** only after *every part* of the run's push has
  returned a terminal success (`completed`, or for a multi-part replace,
  the final `last` part returning `completed`). **[agent design, but made
  safe by guide §3: "upsert ... stateless and idempotent: re-sending the
  same request is harmless" — so if the agent crashes before advancing the
  watermark and the next run re-reads the same window, the re-sent upsert
  is a harmless no-op, not data corruption.]**
- **Overlap window:** the delta query uses `watermark >= lastWatermark −
  overlapSeconds` (not strict `>`), default `overlapSeconds = 300`,
  configurable per job. **[agent design — guide silent on extraction-side
  windowing entirely; safe because re-sent rows are idempotent per guide
  §3 above.]** This covers read-committed snapshot skew and two rows
  sharing the same watermark value where one was missed by a prior run's
  boundary.
- **First run:** a job has no `lastWatermark` until one exists, so
  `upsertDelta` cannot be the first run — `job add` requires an initial
  `replace` before a job may run as `upsertDelta`; the scheduler refuses to
  fire `upsertDelta` on a job whose `lastWatermark` is unset. **[agent
  design — guide silent; replace/upsert are stateless wire modes to
  Planometry, "first run" is purely an agent-side job-lifecycle concept.]**
- **After a replace, the watermark starts at the replace's extraction
  start (read from the source server's clock, as above) minus the
  overlap** (not "now" on the agent's own clock, and not left over from
  before the replace) — the replace's own extraction records the
  server-clock instant it started reading, and `lastWatermark` is set to
  `(that instant − overlapSeconds)` once the replace completes, so the
  very next `upsertDelta` run re-covers anything committed during the
  replace's own extraction window. **[agent design — guide silent.]**
- **Null watermark values:** a row whose watermark column is `NULL` can
  never be reliably selected by `>`/`>=` (SQL `NULL` comparisons are never
  `TRUE`). `job add` and `job test` both run a `COUNT(*) WHERE
  watermarkColumn IS NULL` against the source and report the count to the
  operator, so the gap is visible rather than discovered later. The delta
  query itself also always selects `WHERE watermarkColumn IS NULL`
  alongside the normal range, every run, using the existing filter
  builder's `isNull` operator ORed with the `gte` range condition (no new
  operator, reused from §2) — so a null-watermark row is never silently
  skipped forever. The data-shaping guide given to GMS IT separately tells
  them to expose a column that is never null when a view is the source, so
  this path should be rare in practice. **[agent design — guide silent,
  this is a SQL Server/extraction detail outside the push contract.]**

### 1.2 Delete (one method per job)

Exactly one of four, chosen at `job add`:

| Method | What it needs | State | Where stored | Views? |
| --- | --- | --- | --- | --- |
| **Change Tracking** | DB-level `ALLOW_CHANGE_TRACKING` + table-level `ENABLE CHANGE_TRACKING` already on (agent never turns these on, see 1.5) | last processed `sys_change_version` cursor | job record, like `lastWatermark` | **No** — SQL Server Change Tracking cannot be enabled on a view |
| **Key reconciliation** | a full scan of the source's current key columns, each cycle | the full prior key list, written from the rows of the job's last completed **replace** | **encrypted at rest, like the spool** (reuses `spoolCrypto.ts`'s AES-256-GCM envelope, confirmed existing/reusable), **compared one hash-partitioned bucket at a time** — never loaded fully into memory, never relies on SQL Server's row order | Yes |
| **Soft-delete column** | a boolean flag column on the source, exposed by the view if applicable | none beyond the normal watermark delta | n/a | Yes, if the view projects the flag |
| **None** | — | none | — | Yes |

Detail per method:

- **Change Tracking:** `CHANGETABLE(CHANGES ..., @lastVersion)` returns net
  inserts/updates/deletes since a version; deletes are rows with
  `SYS_CHANGE_OPERATION = 'D'`, sent to Planometry as wire `delete` (key
  columns only, guide §2.3: `"delete needs only the key columns"`).
  **When the job has a filter:** for every changed key returned as an
  insert/update (`SYS_CHANGE_OPERATION` `'I'`/`'U'`), the agent re-reads
  that row's current values and re-applies the job's filter — if the row
  no longer matches, it is sent as wire `delete` instead of `upsert` (safe
  either way, since `delete` is idempotent, guide §3); this closes the gap
  noted in §2 for Change Tracking jobs that also have a filter. The
  cursor read for the *next* run is `CHANGE_TRACKING_CURRENT_VERSION()`
  captured at the **start** of the current run's extraction (not at the
  end), the standard CT usage pattern, so changes committed mid-run are
  never missed. **[agent design — guide never mentions Change Tracking;
  it is a SQL Server source-side feature entirely outside the Planometry
  contract.]**
- **Key reconciliation:** the comparison must not depend on SQL Server's
  sort order — no `ORDER BY <key columns>` streaming merge-diff. (A prior
  draft of this plan used that approach; it is wrong — SQL Server gives no
  sort-order guarantee without an explicit, index-backed `ORDER BY`, and
  relying on one would silently misbehave on a source that doesn't happen
  to return rows in key order.) Instead: both the current scan and the
  prior key list are partitioned into a fixed number of **hash buckets**
  (`hash(wireFormattedKey) % bucketCount`), and the diff runs one bucket at
  a time — each bucket's current and prior keys are small enough to hold
  fully in memory for that bucket only, compared as sets, then discarded
  before the next bucket loads. This bounds memory to one bucket's worth
  of keys regardless of table size and is fully order-independent. Keys
  present in a bucket's "prior" set but absent from its "current" set →
  sent as wire `delete`.
  **Key values are stored, and compared, in their wire-formatted
  form** — the exact same `formatForTarget` output (§3) an upsert for that
  key would send, not the raw SQL Server value — so a formatting change in
  §3 can never cause a false "key changed" diff against a key list written
  before that change.
  **The prior key list is written from the rows of every completed
  `replace`** (every row the replace actually sent, not a separate
  reconciliation scan) — a job whose delete method is key reconciliation
  therefore always has a scheduled replace (§2 ties relative-date
  parameters to this same requirement); the list is never populated by
  periodically re-scanning the source outside of a replace. Both the
  current-scan file and the prior-list file are encrypted at rest like the
  spool (reuses `spoolCrypto.ts`'s AES-256-GCM envelope, confirmed
  existing/reusable).
  **Mass-delete guard:** if the prior key list is empty (zero keys), the
  run refuses to compute any deletes from it (nothing to diff against yet
  — avoids treating "list never populated" as "everything was deleted").
  If the number of keys that would be sent as `delete` exceeds a per-job
  limit (default 20% of the prior list's size), the run stops before
  sending any of those deletes and alerts, rather than silently emptying
  most of a table; a one-run override flag (§9) lets an operator force it
  through when a mass deletion is expected and confirmed.
  **[agent design — guide silent on any agent-local change-detection
  mechanism.]**
- **Soft-delete column:** rows where the flag is true are selected by the
  normal watermark delta query (reusing the existing filter builder's `eq`
  operator, no new code) and sent as wire `delete` (key columns only)
  instead of `upsert`. **A scheduled `replace` for a job using this method
  always excludes flagged rows from its extraction entirely** (the same
  `eq`-on-the-flag condition applied as an exclusion filter on the
  replace's own source query), so a soft-deleted row is never resurrected
  by a subsequent full load. **[agent design — guide silent on source-side
  detection; the resulting wire call is guide §2.3's `delete` mode.]**
- **None:** deletes are not detected incrementally at all; only a
  scheduled `replace` (if the job has one) removes rows that disappeared,
  because guide §3 states replace rows: `"the feed becomes the whole
  table. Old rows go."` **[guide §3]** If the job has neither a delete
  method nor a scheduled replace, deleted source rows are **never**
  removed from Planometry — flagged as a hard warning at `job add`, not
  silently allowed.

### 1.3 Realtime

- **Tick interval:** `pollIntervalSeconds` on the job. **[agent design]**
- **Collapsing changes per key into the final state:** done exactly as
  guide §3's "Real time (change feed)" subsection describes — an insert
  then update collapses to one upsert; insert then delete collapses to one
  delete; delete then re-insert collapses to one upsert — **[guide §3]**,
  sent as one `realtime` request per tick (`rows` to upsert, `deleted` to
  remove, guide §2.3/§3).
- **Rows + deleted split across requests when over the limit:** **[guide
  §3: "A tick over 50,000 rows is split into several realtime requests
  (each stands alone)."]** — the 50,000 cap is on `rows` + `deleted`
  together, same as every other mode (guide §2.3).
- **Source of the tick's content:** Change Tracking if the job's delete
  method is Change Tracking (one `CHANGETABLE` query naturally yields
  inserts/updates/deletes together); otherwise watermark (for the upsert
  side) **every tick**, plus key reconciliation (for the delete side) on
  its **own, slower interval — not every tick**. Full-table key
  reconciliation is a much heavier query than a watermark delta, and
  running it at sub-minute realtime cadence would put load on the source
  the customer did not sign up for; default
  `reconciliationIntervalSeconds = 600` (configurable per job, §9), with a
  warning at `job add` if set low on a large table, since it increases
  source load. **[agent design — guide silent on how a connector detects
  changes; guide only defines the wire shape of the tick.]**
- **Change Tracking version older than the minimum valid version:** the
  job stops and requires a replace (standard SQL Server CT semantics —
  `CHANGE_TRACKING_MIN_VALID_VERSION()` — querying `CHANGETABLE` with a
  version older than this throws on the SQL Server side). **[agent
  design/SQL-Server behavior — guide silent; it is the only safe response
  since the gap can no longer be reconstructed.]**
- **Views:** realtime over a view can never use the Change Tracking path
  (see 1.2) — it always falls back to watermark + key reconciliation, and
  is unavailable entirely if the view has no watermark column.

### 1.4 Views vs. tables — summary

| Method | Table | View |
| --- | --- | --- |
| Upsert (watermark) | Yes | Yes, if the view projects a watermark column |
| Delete: Change Tracking | Yes | **No** (SQL Server limitation) |
| Delete: key reconciliation | Yes | Yes |
| Delete: soft-delete column | Yes | Yes, if the view projects the flag |
| Delete: none | Yes | Yes |
| Realtime | Yes (any delete method incl. CT) | Yes, but never via CT |

`packages/extract/src/types.ts:30`'s `CatalogTable.kind: "table" | "view"`
(confirmed existing) already lets `job add` know which row it's looking at
and restrict the delete-method menu accordingly.

### 1.5 The agent never enables Change Tracking

The agent only ever **reads** Change Tracking state; it never runs `ALTER
DATABASE ... SET CHANGE_TRACKING ON` or `ALTER TABLE ... ENABLE
CHANGE_TRACKING`. **[project policy, stated directly in the task — no guide
citation applies: Change Tracking is a SQL Server source-side feature, not
part of the Planometry contract at all.]**

- `agent sql readonly` gains a new flag (e.g. `--allow-change-tracking`)
  that grants the readonly login `VIEW CHANGE TRACKING` permission only —
  never `ALTER`/enable rights — on top of its existing read grants
  (extends `src/cli/sqlReadonlyScript.ts`, confirmed existing/reusable).
- `agent doctor` gains a new check, `checkChangeTrackingEnabled`, that
  queries `sys.change_tracking_tables` (or attempts
  `CHANGE_TRACKING_CURRENT_VERSION()`) per job's source table and reports
  enabled/disabled without altering anything (extends `doctorChecks.ts`,
  confirmed existing/reusable).

---

## 2. Filters and parameters

- **Reuse:** job source filters use `packages/extract`'s existing
  `filterBuilder.ts` unchanged — confirmed to already support all 11
  required operators (`eq, neq, gt, gte, lt, lte, in, between, startsWith,
  isNull, isNotNull`) with every value bound as a SQL parameter via
  `paramSink.ts`'s token scheme, never concatenated
  (`packages/extract/src/filterBuilder.ts`, `packages/extract/src/
  paramSink.ts`, confirmed). **[agent design — reuse decision; the operator
  set itself is outside the guide's scope entirely, since filtering happens
  on the SQL Server side, before anything is pushed (guide §12 only
  discusses filtering for Part B/pull, out of scope here).]**
- **Gap found:** no existing mechanism lets a filter's `value` be a *named
  parameter* resolved at run time — `paramSink.ts` binds literal values at
  filter-compile time only; there is no indirection layer today. **[agent
  design — new code, not inside packages/extract:]** a new, small
  resolution step in apps/agent (e.g. `planometry/parameters.ts`) turns a
  job's filter condition of the shape `{ column, operator, paramName }`
  into an ordinary `{ column, operator, value }` by looking up `paramName`
  (from the job's saved parameter values, a CLI override, or a relative-
  date token, see below) *before* handing the condition to the unchanged
  `filterBuilder.ts`. No change inside `packages/extract` itself.
- **Saved + per-run override:** parameter values are saved on the job and
  may be overridden for one run via `job run --param name=value`. **[task
  requirement, agent design — purely a CLI/job-state feature, no
  Planometry involvement.]**
- **Relative dates for scheduled runs:** a small fixed set — `today`,
  `today-30d`, `startOfMonth`, `startOfYear` — evaluated in the
  connection's source timezone, no expression language. **[task
  requirement, agent design.]** Reuses the same timezone-resolution
  approach `valueSerializer.ts` already uses for `sourceTimeZone`
  (`Intl.DateTimeFormat`-based), rather than inventing a second TZ
  mechanism.
- **Relative-date tokens are compared, and saved, as the token itself —
  never the date it resolves to on a given day:** the job's saved
  parameter value is the literal string `"today-30d"`, not (e.g.)
  `"2026-09-03"`. The "changing a filter or saved parameter value forces a
  replace" rule below compares the saved token against the token used for
  the current run, so a relative-date parameter rolling forward one day at
  a time is never mistaken for "the filter changed" (which would otherwise
  force a needless full replace on every scheduled run). **[task
  requirement, agent design.]**
- **A relative-date parameter requires a scheduled replace:** a job whose
  strategy is `upsertDelta` or `realtime` and whose filter uses a
  relative-date parameter must also have a scheduled `replace` (§8,
  `--replace-schedule`, §9) — `job add` refuses to create such a job
  without one. Reason: a relative-date filter's window moves every day, so
  rows that age out of it are, from Planometry's point of view, rows that
  "no longer match the filter" — and per the point below, only a periodic
  replace (or key reconciliation, which itself depends on a replace to
  seed its key list, §1.2) reliably removes them. **[task requirement,
  agent design.]**
- **Binding and type-checking:** parameters are always bound SQL
  parameters (via the existing `paramSink.ts`, never concatenated); the
  resolved value's JS type is checked against the mapped column's
  `ExtractType` before binding, at `job add`, `job test`, and immediately
  before each run (ties into §6's "type compatibility" rule). **[agent
  design — new validation, no existing code for this.]**
- **Overrides never mutate saved state:** a run using `--param` overrides
  never changes the job's saved `lastWatermark`, CT cursor, or key list —
  the override is in-memory for that one run only. **[task requirement,
  agent design.]**
- **Changing a filter or a saved parameter value forces the next run to be
  a full replace:** the saved delta state (watermark/CT cursor/key list)
  is only valid against the exact row-set it was computed from; changing
  the filter invalidates all of it. `job update` (or re-running `job add`
  on an existing job) resets `lastWatermark`/CT cursor/key list and marks
  the next run `replace`, as if first run. **[task requirement, agent
  design.]**
- **A row that no longer matches the filter must be removed from
  Planometry:** covered by whichever delete method the job has (§1.2) —
  key reconciliation naturally stops returning a since-filtered-out row's
  key; soft-delete-column rows stop appearing in the delta scan (the
  filter excludes them) but are still removed, since the flag-based
  `delete` logic in §1.2 runs independently of the filter; and Change
  Tracking now also covers this case, via §1.2's filter re-check on every
  changed key. A job with delete method `none` and no scheduled replace
  never removes such rows at all (same gap as §1.2's "no delete method"
  case) — and, per the relative-dates rule above, a job whose filter
  includes a relative-date parameter and whose delete method is anything
  other than key reconciliation gets a warning at `job add` recommending a
  scheduled replace, precisely because of this class of gap. **[agent
  design — guide silent entirely; filtering happens before anything
  reaches Planometry, so Planometry has no visibility into "no longer
  matches."]**

---

## 3. Values

Formatting depends on the **target** column type, so it happens *after*
mapping, not at extraction time. **[task requirement, directly consistent
with guide §4's own framing: "Date | ... A datetime string is accepted and
its date part taken, never shifted" vs. "DateTime | ... converted to UTC" —
the same raw datetime value is formatted differently purely based on which
of the two target types it is mapped to.]**

This is **new code**, not `packages/extract/src/valueSerializer.ts`
unchanged: that file (confirmed, 123 lines) formats a value based only on
its *source* `ExtractType` (`text|number|date|datetime|boolean`) — it has
no notion of a Planometry *target* column type, so it cannot by itself
produce "take the date part" when a `datetime`-typed source value is mapped
to a Planometry **Date** target column, vs. "convert to UTC with Z" when
the same source value is mapped to a **DateTime** target column. New file:
**`apps/agent/src/planometry/formatForTarget.ts`** — `format(sourceType,
targetType, rawValue, sourceTimeZone)` — wraps/reuses `valueSerializer.ts`'s
primitives (parsing, offset extraction, `zonedWallClockToUtc`) but branches
on `targetType` for the date/datetime case.

| SQL Server type | packages/extract source type | Wire value sent | Target types it may map to |
| --- | --- | --- | --- |
| `date` | `date` | `yyyy-MM-dd`, local date part, never shifted | Date **[guide §4]**; Text (stored as that string, guide §4 Text: "any value") |
| `datetime`, `smalldatetime`, `datetime2` (no offset) | `datetime` | Target=DateTime: converted to UTC using the connection's `sourceTimeZone`, `Z` suffix **[guide §4]**. Target=Date: local date part only, never shifted **[guide §4]** | DateTime, Date, Text |
| `datetimeoffset` (has its own offset) | `datetime` | Target=DateTime: UTC using the value's own embedded offset, `Z` suffix **[guide §4]**. Target=Date: local date part at the embedded offset, never shifted **[guide §4; which offset to read the date part from when one is embedded is agent design — guide silent]** | DateTime, Date, Text |
| `time` | `text` (no native Planometry "Time" type exists — guide §4's column-type table lists exactly five: Text/Number/Date/DateTime/Boolean) | plain text, `HH:mm:ss.fffffff` | Text only |
| `bit` | `boolean` | `true` / `false` (canonical choice among guide §4's accepted boolean forms) | Boolean **[guide §4]**; Text (as `"true"`/`"false"`) |
| `int`, `smallint`, `tinyint` | `number` | exact-digit integer string, no thousands separators | Number **[guide §4]**; Text (as that numeric string) |
| `decimal`, `numeric`, `money`, `bigint` | `number` | exact-digit numeric string, no thousands separators/symbols **[guide §4]** | Number **[guide §4]**; Text (as that numeric string) |
| `float`, `real` | `number` | exact-digit numeric string in plain decimal notation, **never exponent/scientific notation** (e.g. `0.0000001`, never `1e-7`) **[guide §4's Number is "any numeric value"; avoiding exponent notation specifically is agent design, since the guide never addresses it]** | Number **[guide §4]**; Text (as that numeric string) |
| `char`, `varchar`, `nchar`, `nvarchar`, `text`, `ntext` | `text` | the string as-is | Text only **[guide §4]** |
| `uniqueidentifier` | `text` | the GUID string as-is | Text only |
| `binary`, `varbinary`, `image`, `rowversion`/`timestamp` | — | **excluded — not supported by this build.** No Planometry target type accepts raw binary (guide §4's five types are all text/numeric/date/boolean); `job add`'s column mapping step refuses to map a binary-family source column at all, rather than guessing an encoding (e.g. base64) the guide never specifies. | none |

`apps/agent/src/planometry/formatForTarget.ts` rejects (at `job add`/`job
test`, per §6) any mapping combination not listed above (e.g. `number` →
Date, `boolean` → Number) as a type-compatibility failure.

---

## 4. Requests and limits

- Rows are sent as JSON objects keyed by **target** column name exactly as
  `/schema` spells them. **[guide §2.3: "rows ... Objects keyed by column
  name exactly as /schema spells them"]** — the output of `formatForTarget`
  is assembled into these objects by the mapping, one call per mapped
  column.
- Part size is bounded by **both**:
  - `min(schemaResponse.maxRowsPerRequest, 50000)` rows (`rows` + `deleted`
    together) **[guide §2.2's dynamic `maxRowsPerRequest` field; guide §7's
    stated fixed ceiling of 50,000 — kept as the hard upper bound regardless
    of what `/schema` reports, in case a future table ever reports higher]**,
    and
  - 64 MB, measured on the **final JSON body** Planometry ends up with
    (the uncompressed JSON, after their server un-gzips it — not the
    gzipped bytes the agent actually puts on the wire) **[guide §7: "64MB
    after decompression"]**. The agent treats **56 MB as its own working
    limit**, closing a part early (even under the row cap) once the
    uncompressed JSON built so far would cross 56 MB — leaving headroom
    below the server's hard 64 MB ceiling rather than targeting it
    exactly. **[agent design — guide states the limit, not how a sender
    should pre-estimate it or how much headroom to leave.]**
- **The uncompressed JSON body is never fully materialized as one string
  in memory.** The agent streams each row's JSON directly into the gzip
  encoder as it is produced (object-by-object, not
  `JSON.stringify(wholeArray)` followed by `gzip(thatString)`), tracking
  the *uncompressed* byte count as it streams for the 56 MB check above.
  Peak memory for one part is therefore bounded by the streaming buffers
  (the gzip encoder's internal window plus one row's worth of JSON at a
  time), never by the full 56 MB uncompressed body — a deliberate
  correction from a prior draft's "running pre-gzip JSON byte length while
  serializing" language, which implied building the whole string first.
  **[agent design.]**
- **The existing `SpoolWriter` row/byte caps are not changed for this.**
  The spool file (NDJSON on disk, written by `packages/extract`'s
  extraction step before anything is pushed) is a separate concern from
  the push request body — its existing caps (confirmed: "max 50k rows or
  16MB per chunk") stay exactly as they are; only the push-request part
  boundary above is new. A spool chunk and a push-request part are not
  required to be the same size; the push path reads rows out of the spool
  and re-partitions them into parts under the 50,000-row/56MB-uncompressed
  bounds independently. **[agent design — corrects a prior draft that
  conflated retuning the spool's byte cap with this new request-body
  limit; the spool cap is explicitly not raised.]**
- `gzip` is always on: pushes are sent with `Content-Encoding: gzip`
  **[guide §7: "a 50,000-row JSON body shrinks 5–10×"]**, reusing the
  existing gzip plumbing already present in `spoolWriter.ts`/the chunk
  upload path (confirmed reusable) as the streaming encoder described
  above.

---

## 5. Replace lifecycle

- **Not idempotent:** `replace` is the one mode guide §3 excludes from its
  idempotency statement (`"upsert, delete and realtime are stateless and
  idempotent"` — replace is conspicuously not listed) **[guide §3]** — a
  second identical replace under a *new* `loadId` is a second full load,
  not a no-op.
- **≤ 50,000 rows:** one request, no `loadId`. **[guide §2.3: "loadId ...
  replace over 50,000 rows only" implies a ≤50,000-row replace is single-
  shot like the other modes.]**
- **> 50,000 rows:** sequential parts, one shared `loadId`, the final part
  carries `last: true` and `totalRows`. **[guide §3's "Large full load
  (8M rows)" example; guide §2.3's `loadId`/`last`/`totalRows` field docs]**
- **`loadRowsReceived` check on every `accepted` response:** the agent
  tracks its own running sent-row count per `loadId` and compares it
  against the server's returned `loadRowsReceived` on every `accepted`
  response **[guide §2.3 confirms the field is returned on `accepted`;
  the agent's act of actively cross-checking it is agent design — guide
  silent on what a sender should do with the number]** — on any mismatch,
  abandon the current `loadId` and start a new one. Starting a new
  `loadId` is always safe because **[guide §3: "A different loadId
  supersedes an open load (its half-filled table is dropped)"]**.
- **Timeout on a middle part (not the `last: true` part):** resolved the
  same way any retry is resolved in this design — resend the identical
  part under the **same** `loadId`, then let `loadRowsReceived` on the
  response decide whether the earlier send had actually landed. If
  `loadRowsReceived` comes back higher than the agent's own running
  sent-row count would predict for a fresh (non-duplicate) receipt, that
  is the signal the earlier send *did* land — the agent treats this as
  "two sends, one counted" and does not double-count locally, continuing
  with the next part as normal. If `loadRowsReceived` instead matches what
  a fresh receipt of this resend would produce, the original send never
  landed and the resend was the only copy. Either way, a middle-part
  timeout never starts a new `loadId` on its own — only the existing
  `loadRowsReceived`-mismatch rule above (unrelated to timeouts) does
  that.
- **After an unclear result on the *last* part** (`last: true` — e.g. a
  network timeout exactly while sending it): read `/schema` before
  deciding **[task requirement]**. The load is treated as **completed**
  only when *both* hold: `rowCount` equals the `totalRows` that was sent,
  **and** `rowsUpdatedAt`/`version` has changed relative to the `/schema`
  read taken at the **start of this run** — not merely "recent," since a
  table that already happened to have the right row count before this run
  started would otherwise be mistaken for a load that just completed. If
  either check fails, the agent resends the last part under the same
  `loadId`. **At most one automatic restart per run is allowed** (one
  resend under a new `loadId`, triggered only by the existing
  `loadRowsReceived`-mismatch rule, never by the last-part-timeout path
  itself) — if the outcome is still unclear after that single restart, the
  agent stops and alerts rather than retrying indefinitely. Whether
  resending the last part itself (under the *same* `loadId`) is safe or
  double-counts rows is still genuinely unknown from the guide — kept as
  the open question "After a timeout on a replace part, is re-sending safe
  or are rows counted twice?" (Planometry list).
- **Agent crash/restart mid-load:** there is no "query an open load's
  status" endpoint in the guide, so on restart the agent never attempts to
  resume the old `loadId` — it starts a brand-new `loadId` from the
  beginning. The old, now-abandoned load is either superseded by the new
  `loadId` **[guide §3]** or discarded after 60 minutes of silence if it
  never gets superseded **[guide §3/§7: "A load silent for 60 minutes is
  discarded. The sender never has to clean up."]**.
- **Retries that would pass 60 minutes:** if the cumulative time already
  spent retrying parts of one `loadId` would push past the 60-minute idle
  ceiling **[guide §7]**, the agent aborts that load locally and alerts,
  rather than keep sending parts against a load Planometry will have
  already discarded. **[agent design, mirrors the prior draft's existing
  language.]**
- **The agent does not de-duplicate (A4):** rows are sent exactly as
  extracted, with no client-side dedup pass, within a part, across parts,
  or for a single-request replace. `totalRows` on the final part is always
  the number of rows actually extracted and sent, not a post-dedup count.
  Exact client-side duplicate-key *detection* (surfacing it as a named
  failure rather than relying solely on the server's rejection) is
  deferred to slice D1. Until then, a source producing duplicate keys is
  caught only by the server, per guide §3's last-wins rule for `upsert`/
  `delete`/`realtime`, and — for `replace` — by whatever rule Planometry
  applies at the swap (kept as the open question below; the fake server's
  current assumption, for testing only, is a `400` at the swap with the
  live table left unchanged).

---

## 6. Errors and schema check

- **401:** wrong/regenerated key, or the table was deleted — the message
  text covers both cases **[guide §2.1: "401 missing or wrong key"; guide
  §6b: "Data source deleted ... 401 on every call"]**. No retry **[guide
  §6b: "Rule for the connector: ... Treat 401 and 404 as configuration
  problems to surface, not to retry."]**
- **404:** key belongs to another table **[guide §2.1]**. No retry
  **[guide §6b, same rule as above]**.
- **400:** nothing is written **[guide §2.3: "nothing half-written"]** —
  stop the job's remaining parts immediately, surface the response
  `message` verbatim, no automatic retry (repeating an identical bad
  request would only 400 again). **[agent design for the "stop, no
  retry" response; the "nothing written" guarantee itself is guide §2.3.]**
- **Network error / 5xx:** retry the *same* request with backoff, for
  `upsert`/`delete`/`realtime`, because they are idempotent **[guide §3:
  "stateless and idempotent: re-sending the same request is harmless"]**.
  For `replace`, follow §5 above (loadId/loadRowsReceived/`/schema`-check
  rules, not a blind same-request retry).
- **`/schema` at the start of every run:** compare it against the job's
  stored mapping; alert on a difference instead of pushing **[guide §6b:
  "Rule for the connector: call `/schema` at the start of every run and
  compare it with the mapping you hold; alert on a difference instead of
  pushing."]**
- **A new, unmapped target column appears:** warning only, run continues
  **[guide §6b: "Column added ... Next push may include it; a push
  without it is still valid" — non-breaking by design]**.
- **A mapped column is removed, renamed, retyped, or a key column
  changes:** stop the run before pushing **[guide §6b: "Column removed/
  renamed/retyped, keys changed ... Read `/schema` again before the next
  push; a push still sending an old column name gets `400`" — stopping
  before pushing is the safe reading of "read `/schema` again ... before
  the next push"]**.
- **`version` is not a schema-drift signal:** it is a per-write row stamp
  **[guide §5: "Every pushed row carries the version of the push that
  wrote it (`_version`, monotonic). `/schema` returns the current
  version."]** — drift detection relies solely on column/key diffing, never
  on watching `version` change. **This explicitly resolves the prior
  draft's open question** ("Is `/schema`'s version a safe drift signal?") —
  it is not carried forward.
- **Type compatibility** (§3's mapping table) is checked at `job add`,
  `job test`, and immediately before each run. **[task requirement, agent
  design.]**
- **Job pause state — which errors pause a job vs. which don't:** the
  following conditions set the job to **paused** — the scheduler will not
  fire it again on any future tick until an operator runs `job resume
  <id>` (§9): **401**, **404** (above), a **schema-check stop** (mapped
  column removed/renamed/retyped, or a key column changed, above), a
  **type-compatibility failure** (above), a **null-key stop** (§7, when
  the job has not opted into skip-and-report), the **mass-delete guard**
  firing (§1.2), and a **Change Tracking version older than the minimum
  valid version** (§1.3). All of these share the same property: retrying
  automatically cannot fix them, because the problem is configuration or
  data shape, not a transient condition — only an operator looking at it
  can. **Network errors and `5xx` responses do *not* pause the job** —
  they retry with backoff within the same run (above), and a run that
  ultimately fails after exhausting retries simply waits for its next
  scheduled tick, exactly as today; there is no new pause state for
  transient failures. **[agent design — guide silent on any job-lifecycle
  concept; guide's 401/404/400 rules are about one HTTP response, not
  about an agent-side scheduling state.]**

---

## 7. Safety rules

- **Null key values are never dropped silently.** Detected while
  *spooling* (streaming, before the first request is ever sent) — the row-
  write callback already passed into the existing `spoolWriter.ts`
  (confirmed, "stream backpressure via write callback") is where the
  per-row key-null check runs, consistent with guide §4 ("Key columns
  must not be null") and guide §2.3's `400` on `"empty key column"`.
  **[guide §4, §2.3; the streaming-check placement is agent design]**
  Default: stop the run and report the null-key row count. Skipping is an
  explicit opt-in per job, and the skipped count is always recorded (even
  when skipping is enabled). An **empty string** in a key column is
  treated the same as `null` (also stopped/reported) as a defensive
  default — the guide doesn't say either way, kept as an open question
  below.
- **A `replace` with zero rows is refused** unless the job explicitly
  opts in. **[agent design — directly because of the open question below,
  "Does a replace with zero rows empty the table?" — until confirmed, the
  safe default is to never risk emptying a live table by accident.]**
- **One job at a time per target table.** Reason: **not** server
  exclusivity — guide §3 explicitly states the opposite, that
  `upsert`/`delete`/`realtime` "can run while a full load is in progress
  on the same table (they hit the live rows, the load fills the new
  table)" **[guide §3]** — so Planometry does *not* block a delta from
  landing during a replace. But guide §3 also states replace "the feed
  becomes the whole table. Old rows go" **[guide §3]** — meaning any delta
  that lands on the *old* live table while a replace is in flight is lost
  the instant the swap happens, since the new table only ever contains
  what the replace's own parts sent. The guide passively allows this race;
  the agent prevents it itself by serializing all pushes to one target
  table through a single job-level mutex (reuses the existing
  `KeyedSemaphore`, confirmed reusable, keyed by `tableUrl` instead of
  `host:port`).
- **No row contents or key values in logs.** Extends the existing
  `ops/logger.ts` discipline (confirmed: "field values restricted to
  scalars (no row data, no secrets)") to also cover the key-reconciliation
  lists from §1.2 — consistent with the task's framing of key lists as
  customer data, handled like the spool (encrypted, streamed, never
  logged).

---

## 8. Scheduler and alerts

- **Schedule format:** a cron-like string per job (reuses the prior
  draft's `SyncJobEntry.strategy.schedule` shape). **[agent design — guide
  has no scheduling concept on the push side at all; guide §6 explicitly
  frames scheduling as the connector's own job: "Nia Core follows the same
  recipe programmatically: ... scheduled deltas as upsert/delete" — guide
  §6]**
- **Timezone for cron schedules:** the cron string is evaluated in the
  connection's configured `sourceTimeZone` (the same timezone already used
  for relative-date parameters, §2, and for date/datetime formatting, §3)
  — not the agent host's local timezone and not UTC. **[agent design —
  guide has no scheduling concept at all.]**
- **Runs missed while the agent was down:** run once on the next
  opportunity, no catch-up for the missed occurrences. **[task
  requirement, agent design.]**
- **A job still running at its next tick:** skip that tick. **[task
  requirement]** Reuses the existing `KeyedSemaphore(jobId)` pattern
  (confirmed reusable) to detect "still running."
- **A paused job (§6) is skipped on every tick** until `job resume <id>`
  clears the pause — distinct from "a job still running at its next tick"
  above, which is a transient, self-clearing skip; a paused job stays
  skipped indefinitely and is reported by `agent status` as paused, not
  merely "last run failed." **[agent design.]**
- **Where an alert appears:**
  - the existing rotating JSON-lines logger (`ops/logger.ts`, confirmed),
  - the existing per-connection state file (`ops/state.ts`, confirmed),
    extended to be per-job (`lastSyncAt`, `lastError`,
    `consecutiveFailures`, etc., one record per job instead of per
    connection),
  - `agent status` (existing CLI, confirmed), extended to print per-job
    status,
  - **exit code:** new — `agent status`/`agent doctor` return non-zero
    when any job is in an alerting state, so monitoring scripts can poll
    it,
  - **Windows Event Log:** **new, not yet implemented** (the current
    logger is a rotating file only, confirmed) — tracked as later
    packaging work, not part of this build (see §10's slice F1 / later
    packaging phase), same status as the prior draft's "no auto-update
    mechanism" item.
- **How a stopped job becomes visible:** the existing `consecutiveFailures`
  counter (confirmed in `ops/state.ts`) crossing a threshold escalates the
  log level and, if configured, is included in the existing generic
  `monitoringHeartbeat` webhook payload (confirmed existing, no customer
  data today), extended to carry per-job alerting state.

---

## 9. Config and CLI

- **Job target = full table URL + key**, exactly as the reference client
  models it — `mini-nia-core.html` stores each target as `{ id, name, push
  /* the table URL */, key /* the push key */ }` (confirmed, lines
  160–224) — matching guide §1's `"One URL, one key, one body."` **[guide
  §1; reference client fields confirmed directly]**
- **Keys only in the encrypted secret store** — reuses
  `secrets/{crypto,keyfile,store}.ts` unchanged (confirmed AES-256-GCM,
  reusable), exactly as the prior draft already planned for
  `agentKeyRef`; the job's `pushKeyRef` follows the same pattern.
- **Column mapping auto-match ported from `norm()`** — the exact function
  read directly from the reference client:
  `mini-nia-core.html:369`: `const norm = (s) => String(s).toLowerCase()
  .replace(/[\s_\-]/g, "");` — case/space/underscore/dash-insensitive
  matching, ported verbatim into `job add`'s auto-mapping step.
- **No backward-compatibility code for the old config** — no agent is
  deployed yet, confirmed; `job add`/`connection add` write only the new
  shapes.
- **Push key is never a command-line argument.** `job add` prompts for it
  interactively (no echo), using the exact same input mechanism
  `connection add` already uses for the SQL Server password (confirmed
  existing pattern) — never `--target-key <key>` on the command line,
  where it would land in shell history and process listings. The prompted
  value is written straight into the encrypted secret store as the job's
  `pushKeyRef`, per the point above.
- **CLI commands and flags, in full:**
  - `nia-agent connection add|test|list|remove` — unchanged, SQL-Server
    side only (confirmed).
  - `nia-agent job add --connection <id> --table <sqlTable> [--filter
    <json>] --target-url <url> --strategy replace|upsertDelta|realtime
    [--watermark-column <col>] [--overlap-seconds <n>] [--delete-mode
    change-tracking|reconciliation|soft-delete|none]
    [--soft-delete-column <col>] [--schedule <cron>]
    [--replace-schedule <cron>] [--poll-interval <seconds>]
    [--map <sourceColumn>=<targetColumn> ...]
    [--on-null-key stop|skip] [--allow-empty-replace]
    [--max-delete-percent <n>] [--reconcile-interval <seconds>]` — new;
    prompts for the push key as above; runs `checkConnection` + `getSchema`,
    auto-matches columns via `norm()`, prints the proposed mapping for
    confirmation. `--map` is repeatable and overrides the `norm()` auto-
    match for specific columns; with no `--map` flag, every mapped source
    column `norm()` manages to match is selected automatically. There is
    no flag to restrict which source columns are considered at all — the
    extracted columns are exactly the mapped source columns. `--on-null-key
    stop|skip` sets §7's null-key behavior (default
    `stop`). `--allow-empty-replace` sets §7's zero-row-replace opt-in.
    `--max-delete-percent` overrides §1.2's mass-delete guard threshold
    (default 20). `--reconcile-interval` overrides §1.3's realtime
    reconciliation cadence (default 600s). `--replace-schedule` sets a
    separate cron for scheduled replaces on a job whose primary `--strategy`
    is `upsertDelta`/`realtime` (required when the job's filter uses a
    relative-date parameter, §2).
  - `nia-agent job test <id>` — new; re-runs connection + schema check,
    also reports the watermark-column clock-skew check and the
    null-watermark row count (§1.1).
  - `nia-agent job list` / `nia-agent job remove <id>` — new.
  - `nia-agent job update <id> [any `job add` flag]` — new; changes a
    job's filter, mapping, schedule, or strategy settings in place;
    changing the filter or a saved parameter value resets delta state and
    forces the next run to `replace`, per §2.
  - `nia-agent job run <id> [--replace] [--param name=value ...]` — new;
    one-off synchronous run, honors `--param` overrides without mutating
    saved job state (§2); `--replace` forces a one-off full replace
    regardless of the job's normal strategy/schedule.
  - `nia-agent job pause <id>` / `nia-agent job resume <id>` — new;
    manually set or clear the paused state (§6/§8); `job resume` also
    clears a pause that was set automatically.
  - `nia-agent job params set <id> name=value` — new; saves a named
    parameter's persistent value on the job (relative-date tokens are
    saved as the literal token string, §2).
  - `nia-agent sql readonly [--allow-change-tracking]` — extends the
    existing command (§1.5).
  - `nia-agent doctor` — extends the existing command with
    `checkTargetReachable`, `checkTargetSchema` (§6), and
    `checkChangeTrackingEnabled` (§1.5).
  - `nia-agent status` — extends the existing command to show per-job
    state, including paused jobs (§6/§8).
  - `nia-agent healthcheck`, `nia-agent version` — unchanged.

---

## 10. Slices

Every slice is committed on its own. Each states a goal, the files it
touches, and one allowed-test + one refused-test per new/changed path.
**Typechecks clean at the end of every single slice** — not just at the
end of the whole phase — so the tree never sits on a broken intermediate
commit.

**A1) Delete the old work-queue protocol; rewrite the v4 wire types,
client, and fake server.**
Goal: reach a state where the v4 wire contract exists and is testable
end-to-end against a fake server, even though nothing real calls it yet.
Files: delete `planometry/{pollLoop,catalogSync,catalogFingerprint,
heartbeatScheduler}.ts` and their tests; rewrite `planometry/{types,
client}.ts`; rewrite `testing/{fakePlanometryServer,
runFakePlanometryServer,planometryCtl}.ts`. `agent start` is left able to
compile and run with zero jobs configured (no jobs exist yet — `job add`
doesn't land until A2) — it idles, which is correct for this slice, not a
placeholder to fix later. **This slice's own commit also updates
`docs/decisions.md`** with every test name deleted in this slice (per
CONVENTIONS.md's rule for deleted tests) — not deferred to F1, since the
deletions happen here.
Allowed: *"`client.checkConnection()` against the fake server's v4 surface
returns ok for a valid URL+key."* Refused: *"the old `client.postCatalog()`
method no longer exists on the client (a compile-time check, not a
runtime one)."*

**A2) Job config, CRUD, and the `job` CLI's add/test/list/remove/update.**
Goal: an operator can create, inspect, and remove a job record, with its
mapping and push key stored correctly — no actual sync runs yet.
Files: rewrite `config/types.ts` (`SyncJobEntry`); extend `config/store.ts`
with job CRUD; new `cli/jobCommands.ts` (`add`/`test`/`list`/`remove`/
`update`, §9); push key prompted and stored via `secrets/store.ts`
(existing); column mapping auto-match via ported `norm()`; type-
compatibility check (§3's mapping table) wired in at `job add`/`job test`.
Allowed: *"`job add` auto-matches a source column to a target column
whose name differs only by case and underscores, via `norm()`."* Refused:
*"`job add` has no `--target-key` flag at all — the push key is only ever
accepted via the secure prompt."*
A `job test <id>` at the end of this slice checks connection + schema
only (watermark/null checks land in C1).

**A3) Target-type-dependent value formatting and the push request
builder.**
Goal: given a mapped row, produce the exact wire-ready JSON row and a
correctly bounded request part — no network send wired to a real run yet.
Files: new `planometry/formatForTarget.ts` (§3's table); new
`sync/requestBuilder.ts` — builds parts under the 50,000-row/56MB-
uncompressed bounds (§4), streaming into gzip rather than building one
string.
Allowed: *"a `datetime2` source value mapped to a Planometry Date target
column keeps only its local date part, never shifted."* Refused: *"a
`binary`/`varbinary` source column is refused at the mapping step, never
silently reaches `formatForTarget`."*

**A4) Replace lifecycle, wired into a real run.**
Goal: `job run <id> --replace` actually pushes a full load to the fake
server and back, with every safety rail from §5/§7 enforced.
Files: new `sync/replaceLoad.ts` (`loadId`/`last`/`totalRows`/
`loadRowsReceived` tracking, middle-part vs. last-part timeout handling,
one-restart cap, §5); rewrite `sync/runSync.ts` to call it; `job run`
wired to a real synchronous run; `/schema`-at-start-of-run check (§6)
wired in; null-key and zero-row-replace guards (§7) wired in; per-table
mutex (§7, reusing `KeyedSemaphore`) wired in; `docs/manual-testing/
agent.md` updated to describe `job run --replace` against the fake server.
Allowed: *"a replace of 60,003 rows splits into 2 parts; the second
carries `last`+`totalRows`; the load is `completed` only once `rowCount`
equals `totalRows` and `/schema`'s version has changed since the run's
own start."* Refused: *"a replace with zero extracted rows is refused
without `--allow-empty-replace`."*

**B1) Filters and parameters on jobs.**
Goal: a job's source query can be filtered, with named parameters
(including relative-date tokens) resolved before `filterBuilder.ts` ever
sees them.
Files: new `planometry/parameters.ts` (named-parameter + relative-date
resolution, token-compared-not-resolved-value change detection, §2); `job
add`/`job update` gain `--filter`/`--param`/relative-date-requires-
replace-schedule validation (§2).
Allowed: *"`job run --param fromDate=2026-01-01` overrides the saved value
for one run without mutating the job's saved parameter value."* Refused:
*"`job add` for an `upsertDelta` job whose filter uses a relative-date
parameter, with no `--replace-schedule`, is rejected."*

**B2) Scheduler rewrite: per-job isolation, backoff, alerts, pause/
resume, doctor checks.**
Goal: close the fail-fast/no-backoff gap confirmed in §11 and give every
job its own cadence, state, and pause lifecycle.
Files: rewrite `agentLoop.ts` (per-job cadence via `Promise.allSettled` or
independent per-job timers, not `Promise.all` — §11's confirmed gap);
extend `ops/state.ts` to per-job; extend `doctorChecks.ts`
(`checkTargetReachable`/`checkTargetSchema`/pause-aware reporting); `job
pause`/`job resume` (§9); pause triggers wired in for 401/404/schema-stop/
type-mismatch/null-key-stop (from A2–A4) — mass-delete-guard and CT-
version pauses land in D1/D3 once those methods exist; cron schedules
evaluated in `sourceTimeZone` (§8).
Allowed: *"one job's top-level loop throwing does not stop any other
job's loop from continuing to run"* — the new test closing §11's
confirmed gap. Refused: *"a job in the paused state is skipped on every
scheduler tick until `job resume` is called, even if its cron schedule
would otherwise fire."*

**C1) Upsert (watermark).**
Goal: `upsertDelta` becomes a real, schedulable strategy.
Files: new `sync/watermark.ts` (server-clock-based `lastWatermark`,
300-second overlap, null-watermark `IS NULL` query + count reporting,
clock-skew check for `job test`, §1.1); wired into the sync executor and
into B2's scheduler.
Allowed: *"`lastWatermark` advances to `(server-clock-read-at-run-start −
overlapSeconds)` only after every part of a successful run, never to the
max value seen among extracted rows."* Refused: *"a run that fails
partway through leaves `lastWatermark` unchanged on disk."*

**D1) Delete: key reconciliation.**
Goal: the first real delete method, and the one every relative-date job
depends on (§2) for its required replace to actually populate a key list.
Files: new `sync/keyReconciliation.ts` (hash-bucket order-independent
diff, wire-formatted key storage, key list written from completed-replace
rows, mass-delete guard, encrypted via `spoolCrypto.ts`, §1.2); D1's
mass-delete-guard trigger wired into B2's pause logic.
Allowed: *"a key present in a bucket's prior set but absent from that same
bucket's current set is sent as a `delete`, using the same wire-formatted
value a prior upsert for that key would have used."* Refused: *"a
reconciliation run against an empty prior key list computes zero deletes,
never treating 'no prior list yet' as 'everything was deleted.'"*

**D2) Delete: soft-delete column.**
Goal: the lightest-weight delete method, including the replace-exclusion
behavior.
Files: new `sync/softDelete.ts` (flag-based delete detection and replace-
time exclusion, §1.2).
Allowed: *"a row whose soft-delete flag is true is sent as `delete`, not
`upsert`, on the next delta run."* Refused: *"a scheduled replace for a
soft-delete job never re-includes a flagged row, even though the
replace's own extraction query is otherwise unfiltered by the job's
normal filter."*

**D3) Delete: Change Tracking (last of the three, most source-side
risk).**
Goal: the heaviest-weight delete method, including the filter-interaction
fix and the CT-version pause trigger.
Files: new `sync/changeTracking.ts` (`CHANGETABLE` query, min-valid-
version check, filter re-check on changed keys turning stale matches into
deletes, §1.2); `cli/sqlReadonlyScript.ts` extended (`--allow-change-
tracking`); `doctorChecks.ts` extended (`checkChangeTrackingEnabled`);
D3's too-old-CT-version trigger wired into B2's pause logic.
Allowed: *"a changed key whose current row no longer matches the job's
filter is sent as `delete`, not `upsert`."* Refused: *"a Change Tracking
version older than `CHANGE_TRACKING_MIN_VALID_VERSION()` pauses the job
and requires a replace to clear, never silently resets the cursor."*

**E1) Realtime.**
Goal: the last strategy, built last because it composes every delete
method above.
Files: new `sync/realtimeTick.ts` (per-key collapse, 50,000-row
rows+deleted split, Change-Tracking-or-watermark+slower-interval-
reconciliation source selection, §1.3).
Allowed: *"a key inserted then deleted within one tick is sent only in
`deleted`, never in `rows`."* Refused: *"a tick whose `rows`+`deleted`
exceeds 50,000 combined is rejected from being sent as a single request —
it must be split first."*

**F1) Docs.**
Goal: bring the narrative docs in line with v4 reality, now that the code
is done.
Files: `docs/pilot/*`, `docs/manual-testing/agent.md` (further updates
beyond A4's), `docs/plans/planometry-integration.md` (marked superseded,
left as history, per this file's intro). No code tests in this slice
(docs-only); any test-name deletions from A1 are already recorded in
`docs/decisions.md` by A1 itself, not repeated here.

End of each slice: commit only that slice's files; that slice's own
`apps/agent`/`packages/extract` typecheck and test suite green before
moving to the next slice. Full combined test suite at the end of the
whole phase (same sandbox rule as the existing phase docs — throwaway
containers only, never the dev sandbox DB).

---

## 11. Inventory — checked against the code

### apps/agent

| File | Keep / Rewrite / Delete | Reason |
| --- | --- | --- |
| `src/index.ts` | Keep | CLI routing, protocol-agnostic |
| `src/agentLoop.ts` | **Rewrite** | Per-connection poll loop → per-job scheduler (§8); current isolation/backoff gaps below must not be carried forward unexamined |
| `src/planometry/types.ts` | **Rewrite** | Old wire shapes (`CatalogPushRequest`, `WorkItem`, chunk headers) have no v4 equivalent |
| `src/planometry/client.ts` | **Rewrite** | Old methods (`postCatalog`, `pollWork`, `pushChunk`, `heartbeat`, `reportComplete/Failed`, `ping`) replaced by `checkConnection`/`getSchema`/`push` (§2 of prior draft, kept) |
| `src/planometry/network.ts` | Keep | Proxy resolution is protocol-agnostic |
| `src/planometry/pollLoop.ts` | **Delete** | No work queue to poll in v4; agent is self-scheduled per job |
| `src/planometry/catalogSync.ts` | **Delete** | No catalog-push endpoint in v4; replaced by per-job `/schema` read-and-compare (§6) |
| `src/planometry/catalogFingerprint.ts` | **Delete** | Existed only to decide when to push the old catalog |
| `src/planometry/heartbeatScheduler.ts` | **Delete** | v4's push endpoint has no heartbeat call; its 60-minute idle timeout is server-enforced against the last part received (§5), not client-pinged |
| `src/sync/runSync.ts` | **Rewrite** | New flow: extract → map → `formatForTarget` → spool → push parts, keyed by job, not a Planometry-issued run id |
| `src/sync/chunkUploader.ts` | **Rewrite** | Body shape changes to `{mode, rows, deleted?, loadId?, last?, totalRows?}`; retry rule changes (400 never retries; only network/5xx does, per §6) — its existing exponential-backoff *mechanism* (`backoffDelayMs()`, confirmed at `chunkUploader.ts:57–60`) is reused, the call sites around it are not |
| `src/sync/spoolWriter.ts` | Keep | NDJSON chunk writer, protocol-agnostic; row/byte cap values retuned per §4, not its logic |
| `src/sync/spoolCrypto.ts` | Keep | AES-256-GCM envelope, reused as-is for spool **and** for the new key-reconciliation list file (§1.2) |
| `src/sync/diskSpace.ts` | Keep | Protocol-agnostic preflight check |
| `src/sync/concurrency.ts` | Keep | `Semaphore`/`KeyedSemaphore` reused for job/table/host serialization (§7, §8) |
| `src/config/types.ts` | **Rewrite** | `PlanometryConnectionConfig`/`lastCatalogFingerprint` gone; new `SyncJobEntry` (§9) |
| `src/config/store.ts` | **Rewrite** (extend) | Add job CRUD alongside existing connection CRUD |
| `src/config/paths.ts` | Keep | Protocol-agnostic |
| `src/secrets/{crypto,keyfile,store}.ts` | Keep | Unchanged; jobs add a `{ pushKey }` secret shape alongside the existing one |
| `src/ops/{logger,shutdown,spoolUsage,diskSpace}.ts` | Keep | Protocol-agnostic |
| `src/ops/state.ts` | **Rewrite** (extend) | Per-connection state → per-job state (§8) |
| `src/ops/syncFailureLog.ts` | Keep | Escalation logic is protocol-agnostic |
| `src/ops/monitoringHeartbeat.ts` | Keep | Generic webhook, extended payload only (§8) |
| `src/cli/connectionCommands.ts` | Keep | SQL-Server side unchanged |
| `src/cli/sqlReadonlyCommand.ts`, `sqlReadonlyScript.ts` | **Rewrite** (extend) | Add `--allow-change-tracking` (§1.5) |
| `src/cli/healthcheckCommand.ts`, `versionCommand.ts` | Keep | Unchanged |
| `src/cli/doctorCommand.ts`, `doctorChecks.ts` | **Rewrite** (extend) | Replace old ping-based check; add `checkTargetReachable`/`checkTargetSchema`/`checkChangeTrackingEnabled` (§1.5, §6) |
| `src/cli/permissionChecks.ts` | Keep | SQL-side, unchanged |
| **new** `src/cli/jobCommands.ts` | New | `job add/test/list/remove/run/params` (§9) |
| **new** `src/planometry/parameters.ts` | New | Named-parameter + relative-date resolution (§2) |
| **new** `src/planometry/formatForTarget.ts` | New | Target-type-dependent value formatting (§3) |
| **new** `src/sync/{watermark,keyReconciliation,softDelete,changeTracking,realtimeTick,replaceLoad}.ts` | New | §1, §5 |
| `src/testing/fakePlanometryServer.ts` | **Rewrite** | Internal Table surface (connection check/schema/push, all 4 modes, fault injection) replacing work/chunk/heartbeat model |
| `src/testing/runFakePlanometryServer.ts`, `planometryCtl.ts` | **Rewrite** (follow fake server) | Thin wrappers around the fake server; updated to match its new surface |
| `src/testing/manualExtractCli.ts` | Keep | Ad-hoc extraction testing, protocol-agnostic |
| `src/generated/version.ts` | Keep | Build-time constant, unrelated |

**Confirmed per-connection isolation and reconnect backoff (file:line,
test names):**

- `apps/agent/src/agentLoop.ts:58–62` drives every connection with
  `Promise.all(config.connections.map((entry) => runConnectionLoop(...)))`
  — this is **fail-fast**: if one connection's top-level loop rejects, the
  whole `Promise.all` rejects immediately, which would tear down every
  other connection's loop too. Within one connection, work-level errors
  *are* isolated (`agentLoop.ts:130–172`'s `handleWork()` catches and logs,
  does not re-throw) — but a top-level failure in `runPollLoop()` itself is
  not caught anywhere before it reaches the `Promise.all`.
- **No reconnect/backoff exists at the connection-loop level** — `pollLoop.ts`
  runs until aborted and has no retry wrapper; any thrown error kills that
  connection's loop outright. The only backoff in the codebase is inside
  `apps/agent/src/sync/chunkUploader.ts:57–60` (`exp = baseDelayMs *
  2^(attempt-1)` + random jitter, 5 attempts, 500 ms base), and it is
  scoped to a single chunk upload, not to reconnecting a dead
  connection/job loop.
- `apps/agent/src/agentLoop.test.ts` has **no test** for "`conn-2` failing
  does not affect `conn-1`" and **no test** for reconnect/backoff — its
  existing tests (`"polls, syncs, and records state for a successful
  run, stopping cleanly on abort"`, `"records a sync failure when the
  extract itself errors"`, `"records a sync failure when connecting to
  the database throws"`, `"stops promptly on abort with no connections
  configured"`) all use a single connection and only cover *work-level*
  error recording, not top-level loop isolation or reconnection. This gap
  must be closed as part of slice B2's `agentLoop.ts` rewrite (per-job
  cadence should use `Promise.allSettled` or independent per-job timers,
  not `Promise.all`), with a new test added for exactly the isolation case
  that's missing today.

### packages/extract

| File | Keep / Rewrite / Delete | Reason |
| --- | --- | --- |
| `src/types.ts` | Keep | `CatalogTable.kind`, `FilterCondition`, `ExtractType` all reused unchanged |
| `src/catalog.ts` | Keep | `resolveTable`/`resolveColumn`, exact-match only, unrelated to the push protocol |
| `src/filterBuilder.ts` | Keep | All 11 operators + parameterized binding confirmed sufficient (§2); the new named-parameter layer sits above it, unchanged itself |
| `src/valueSerializer.ts` | Keep | Source-type formatting reused as the primitive inside the new `formatForTarget.ts` (§3); not reused standalone for the final wire call, since it has no target-type awareness |
| `src/paramSink.ts` | Keep | Token-based binding, unchanged; the new parameter-resolution layer (§2) feeds it literal values exactly as today |
| `src/ndjsonWriter.ts` | Keep | Still used for the **internal spool file format** (via `spoolWriter.ts`) — unrelated to the final Planometry wire format, which is a JSON body, not NDJSON |
| `src/mssql/{connection,introspect,streamExtract,buildSelectSql,nativeTypeMapping,quoteIdent}.ts` | Keep | SQL-Server extraction/type-mapping, fully protocol-agnostic; `buildSelectSql.ts`/`nativeTypeMapping.ts` are exactly what §3's value table is grounded in |
| `src/testing/planometryClient.ts` | Keep | NDJSON-stream test harness for extract's own internal contract (Phase 1), unrelated to the Planometry v4 wire format |

---

## Later: pull mode

Guide Part B (§9–§13, Option 3 — Planometry pulls from the connector's own
REST API) is explicitly out of scope for this plan. If GMS or a future
customer ever needs it, it reuses `@nia/extract`'s existing catalog/
filter/value-serialization code behind a new thin HTTP listener with
cursor pagination (guide §11) and bearer-token auth (guide §10) — not
scoped further here.

---

## Open questions, for Planometry

- After a timeout on a replace part, is re-sending safe, or could rows be
  counted twice? (§5)
- Is an empty string in a key column rejected like `null`? (§7)
- Does a `replace` with zero rows empty the table? (§7)
- Duplicate keys across parts of one `replace` load: rejected, or last
  wins across the whole load (not just within a part)? (§5)
- Staging URL, a test Internal Table, and a key, for integration-testing
  against the real backend (not only the fake server).
- Can a connector create or update an Internal Table's columns by API
  (vs. only through the Planometry UI, as guide §6 describes)?
- Timeline for Internal Tables as a mapping source (guide §5: "not offered
  as a mapping source yet").
- Is `loadId` accepted for a load under 50,000 rows that is split by the
  64 MB request-size limit? (§5)
- How long can the last part of a large load take? (§5)

## Open questions, for GMS IT

Per source table that will feed a job:

- Is it a table or a view? Does it have a primary key?
- Is there a last-modified column usable as a watermark?
- Are rows hard-deleted, soft-deleted (and if so, via which column), or
  never deleted?
- Can Change Tracking be enabled on the database and on the table (edition/
  permission check, §1.5 — the agent will only ever read it, never enable
  it, so this must be done by GMS IT beforehand if that method is chosen)?
- What timezone are the date-time values stored in (feeds `sourceTimeZone`,
  §3)?
