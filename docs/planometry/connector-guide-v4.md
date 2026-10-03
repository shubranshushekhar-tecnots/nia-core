# Planometry Connector Guide — getting a customer's data into Planometry

_Version 4 · 2026-10-03 · Backend: `PlanometryBackend.API/Controllers/PushController.cs`, `PlanometryBackend.Services/Services/DataSourceService.Push.cs` (push), `DataSourceService.Api.cs` (pull)_

A customer's database usually sits on a private network, so Planometry cannot connect to it directly (that is option 1, the ordinary Database source, and it only works when the database is reachable). A connector such as Nia Core sits next to the data and bridges the gap in one of two ways. Both are secured by one URL and one key; they differ in **who calls whom**. Build both: the customer's network decides which one is used.

| | Option 2 — the connector pushes | Option 3 — Planometry pulls |
| --- | --- | --- |
| Who exposes the API | **Planometry** exposes the push API and issues the connector a key | **The connector** exposes a secure HTTPS API and issues Planometry a key |
| Planometry data source | **Internal Table** (`type: InternalTable`, engine `Connector`): the user defines the columns and key, Planometry creates the empty table | **REST API** (`type: Api`): URL, `Authorization` header, pagination, optional data path |
| Where the rows live | In Planometry, in a table it owns; the connector keeps it in sync | Nowhere in Planometry. Every preview and every run reads the API again |
| How rows move | The connector sends parts of up to 50,000 rows: a full load, deltas, or real-time ticks | Planometry asks for one page at a time (up to 50,000 rows) and feeds each page to the run as it arrives |
| Where filtering and transforms happen | In the connector, before it pushes | **In the connector's API.** Planometry cannot push a filter into an HTTP endpoint, so the API exposes its own filter parameters |
| Network requirement | Only **outbound** HTTPS from the connector to Planometry: works from a private network | Planometry must be able to reach the connector's API (public endpoint, or Planometry's outbound IPs allow-listed) |
| Best for | ERPs on private networks, big history tables, change feeds, drill to source later | Feeds the connector already serves, data that must always be read fresh, sources where nothing may be stored outside |

**Part A (sections 1 to 8) is option 2, the push.** **Part B (sections 9 to 13) is option 3, the pull.**

# Part A — Option 2: the connector pushes into an Internal Table

An **Internal Table** is a table Planometry owns and keeps in sync with a customer's system. Planometry defines the structure; anything that can make an HTTPS call with a bearer token fills it: an integration platform (Boomi, MuleSoft, Azure Data Factory, Power Automate), our own Nia Core agent, or a script. The reference client is `test-external-datasources/mini-nia-core.html` — plain JavaScript, implements everything in this part.

The type is `InternalTable` and the engine is `Connector` (`DataSourceType.InternalTable`, `DataSourceEngine.Connector`); the UI shows **Internal Table** and **Connector**.

## 1. The contract in one line

```
POST https://api.planometry.com/api/datasources/internal-tables/{table}
Authorization: Bearer <push key>
Content-Type: application/json

{ "mode": "upsert", "rows": [ { "invoice_no": "INV-1001", "line_no": 1, "qty": 12, "amount": 540.00 } ] }
```

One URL, one key, one body. `{table}` is the table's id (`ds-FM2PkWft6L46thZS`), which never changes, so renaming the table in Planometry never breaks a connector; both the URL and the key are shown on the table's edit page. The key alone decides which table is written; the id in the URL must match it (`404` otherwise). A regenerated key invalidates the old one at once.

Stateless: every request stands alone. Nothing is opened, closed, polled or kept alive. CORS allows any origin on these routes.

Every response is `{ "success": true|false, "message": "…", "data": { … } }`.

## 2. Calls

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/datasources/internal-tables/{table}` | Connection check: reachable, key valid, which table |
| GET | `/api/datasources/internal-tables/{table}/schema` | Columns, keys, allowed modes, row count, version — as of now |
| POST | `/api/datasources/internal-tables/{table}` | Push rows |

A connector needs only the POST. The two GETs are for a "Test connection" button and for checking the columns before a run.

### 2.1 `GET /api/datasources/internal-tables/{table}`

```json
{ "status": "ok", "dataSourceId": "ds-k133RLmCxLrec7ww", "dataSourceName": "GMS Hyper Sales", "serverTime": "2026-10-02T08:15:00Z" }
```

`401` missing or wrong key · `404` key belongs to another table.

### 2.2 `GET /api/datasources/internal-tables/{table}/schema`

```json
{
  "dataSourceId": "ds-k133RLmCxLrec7ww",
  "dataSourceName": "GMS Hyper Sales",
  "columns": [
    { "name": "invoice_no",    "type": "Text",   "isKey": true  },
    { "name": "line_no",       "type": "Number", "isKey": true  },
    { "name": "invoice_date",  "type": "Date",   "isKey": false },
    { "name": "customer_code", "type": "Text",   "isKey": false },
    { "name": "qty",           "type": "Number", "isKey": false },
    { "name": "amount",        "type": "Number", "isKey": false }
  ],
  "keyColumns": ["invoice_no", "line_no"],
  "supportedModes": ["replace", "upsert", "delete", "realtime"],
  "maxRowsPerRequest": 50000,
  "rowCount": 8012345,
  "rowsUpdatedAt": "2026-10-02T07:58:11Z",
  "version": 1790921891000
}
```

Every table has at least one key column (required at creation), so all four modes are always available.

### 2.3 `POST /api/datasources/internal-tables/{table}`

| Field | Meaning |
| --- | --- |
| `mode` | `upsert` (default) · `replace` · `delete` · `realtime` |
| `rows` | Objects keyed by column name exactly as `/schema` spells them, ≤ 50,000 per request (`rows` + `deleted` together), ≤ 64 MB. Missing key = `null`. Unknown key = `400`, nothing written. `delete` needs only the key columns. With `realtime`: the rows to upsert |
| `deleted` | `realtime` only: the rows to remove, key columns only |
| `loadId` | **replace over 50,000 rows only**: every part of one full load carries the same id |
| `last` | with `loadId`: `true` on the final part — verifies and swaps the new table live |
| `totalRows` | optional with `last`: must equal the rows received in this load, else the load is discarded (`400`) |

Response:

```json
{
  "mode": "Upsert",
  "status": "completed",
  "rowCount": 8012400,
  "rowsAffected": 2,
  "version": 1790921950123,
  "completedAt": "2026-10-02T08:19:10Z"
}
```

`status`: `completed` = rows are live · `accepted` = a replace part stored, waiting for the one marked `last` (then `loadId` and `loadRowsReceived` are returned) · `rowsAffected`: replace = rows loaded, upsert = inserted or updated, delete = removed, realtime = upserted + removed (with `rowsDeleted` giving the removed part).

Codes: `200` · `400` bad cell, unknown column, empty key column, mode not supported by this table, more than 50,000 rows, count mismatch — nothing half-written · `401` / `404`.

## 3. Modes

| Mode | What happens | Use |
| --- | --- | --- |
| `upsert` (default) | Rows matched on the key columns are updated, others inserted. Duplicate keys inside one request: the last one wins | The delta the connector detected; also the mode to use when unsure |
| `replace` | The feed becomes the whole table. Old rows go; new rows are served only once all parts have landed | First load, periodic full reload |
| `delete` | Rows matched on the key columns are removed | Rows that disappeared at the source |
| `realtime` | `rows` are upserted and `deleted` removed, in one transaction with one version. Upserts apply first, so a key in both lists ends up removed | Real time: everything a change feed produced since the last tick |

`upsert`, `delete` and `realtime` are stateless and idempotent: re-sending the same request is harmless, order between requests does not matter, and they can run while a full load is in progress on the same table (they hit the live rows, the load fills the new table).

### Real time (change feed)

Real time has all three operations at once — a row is inserted, another updated, a third deleted in the same second — so it is its own mode rather than three requests. A connector in real-time mode watches the source (CDC, triggers, a modified-at column, polling a change log) and, every tick, collapses what it saw per key into the final state: a row that was inserted then updated is one upsert; a row that was inserted then deleted is one delete; a row deleted then re-inserted is one upsert. It sends that as a single `realtime` request:

```
POST {url}  { "mode": "realtime",
              "rows":    [ { "invoice_no": "INV-1001", "line_no": 1, "qty": 12, "amount": 540.00 } ],
              "deleted": [ { "invoice_no": "INV-0997", "line_no": 2 } ] }
→ { "mode": "Realtime", "status": "completed", "rowsAffected": 2, "rowsDeleted": 1, "rowCount": 8012400, "version": 1790921950123 }
```

Tick as often as the source changes; an empty tick need not be sent. A tick over 50,000 rows is split into several `realtime` requests (each stands alone). Nothing else changes for the connector: same URL, same key, and a full `replace` load is still the way to resync from scratch. Planometry stamps each tick with a version, which is what later lets mappings react to exactly these rows.

### Large full load (8M rows)

```
POST {url}  { "mode": "replace", "loadId": "full-2026-10-02", "rows": [ … 50,000 … ] }   → status: accepted
POST {url}  { "mode": "replace", "loadId": "full-2026-10-02", "rows": [ … 50,000 … ] }   → status: accepted
…
POST {url}  { "mode": "replace", "loadId": "full-2026-10-02", "rows": [ … ], "last": true, "totalRows": 8012345 }   → status: completed
```

- The first part with a new `loadId` opens a new table; each part appends; `last` verifies and swaps. Mappings keep reading the previous rows until the swap.
- A different `loadId` supersedes an open load (its half-filled table is dropped). A load silent for 60 minutes is discarded. The sender never has to clean up.
- A failed part (`400`) is simply re-sent; parts of one load must not overlap in time (send them in sequence).
- Integration platforms do this natively: they batch documents (e.g. 10,000 per call) and call the same URL repeatedly; map `loadId` to the run id and `last` to "is final batch".

## 4. Value formats

| Column type | Accepted JSON |
| --- | --- |
| Text | any value; non-strings are stored as their JSON text |
| Number | JSON number or plain numeric string (`"12.5"`). No thousands separators, no symbols |
| Date | `"yyyy-MM-dd"`. A datetime string is accepted and its date part taken, never shifted |
| DateTime | ISO 8601 (`"2026-10-01T14:30:00Z"`); converted to UTC |
| Boolean | `true` / `false`, `1` / `0`, `"yes"` / `"no"` |

`null` is allowed in every non-key column. Key columns must not be null.

## 5. What happens inside Planometry

- Every pushed row carries the **version** of the push that wrote it (`_version`, monotonic). `/schema` returns the current version.
- Today the table is the product: a live copy of the source inside Planometry, previewable and filterable like an uploaded file. **Internal Tables are not offered as a mapping source yet**; how they feed models (direct reads, incremental runs, pricing) is still being decided.
- Deletes remove rows from the table only; nothing downstream is touched by this API.

## 6. Setting up a connector (Boomi as the example)

1. In Planometry: create the Internal Table, define columns and tick the key column(s), copy the URL and the key.
2. HTTP Client connection: URL = `https://api.planometry.com`, no auth preset.
3. HTTP Client operation: `POST`, path `/api/datasources/internal-tables/ds-FM2PkWft6L46thZS`, header `Authorization: Bearer <key>`, content type `application/json`.
4. Map shape: source fields → a JSON profile built from the sample body in §1, `mode` fixed to `upsert`.
5. Optional: a second operation `GET /api/datasources/internal-tables/ds-FM2PkWft6L46thZS` for the connection test; `GET …/schema` to validate the mapping on each run.
6. Schedule or trigger the process in the platform. Planometry has nothing to configure.

Nia Core follows the same recipe programmatically: check, read schema, full loads as `replace` with a `loadId`, scheduled deltas as `upsert`/`delete`, real time as `realtime` ticks.

## 6b. When something changes on the Planometry side

The user can edit the Internal Table at any time; the connector may be idle or mid-push. This is what each change does and what the connector sees.

| Change in Planometry | Effect on the table | What the connector sees |
| --- | --- | --- |
| **Data source deleted** | Table dropped | `401` on every call. A request in flight gets `400` "deleted while you were pushing". Nothing it sends can land anywhere afterwards |
| **Renamed** | Rows untouched; URL unchanged (it is id-based); key unchanged | Nothing |
| **Column added** | `ALTER ADD`; existing rows get `null` in it | Next push may include it; a push without it is still valid |
| **Column removed / renamed / retyped, keys changed** | Rows are kept. Removed: `ALTER DROP`, only that column's values go. Renamed: `ALTER RENAME`, values kept. Retyped: stored values converted in place (refused if any value does not convert). Keys: index rebuilt (refused if rows are not unique on the new key) | Read `/schema` again before the next push; a push still sending an old column name gets `400` |
| **Any edit or delete while a full load is in progress** | **Refused** in the UI until the load finishes or goes idle for 60 min | The load completes normally |
| **New key issued** | Nothing | `401` with the old key, at once; an open load dies and is superseded by the next push |

**One rule.** Every change to the table (name, columns, types, key) is allowed whenever no full load is in flight, and the rows are always kept; there is no switch to flip and adding a column is not a special case. A multi-request `replace` load is tracked (open → parts → last), so Planometry knows it is in progress and refuses edits and delete for its duration. Single-request pushes last milliseconds to seconds and are atomic, so they interleave with any edit safely: the push either lands whole or returns a clear `400` for the mismatch.

**Rule for the connector:** call `/schema` at the start of every run and compare it with the mapping you hold; alert on a difference instead of pushing. Treat `401` and `404` as configuration problems to surface, not to retry.

## 7. Limits

| Limit | Value |
| --- | --- |
| Rows per table | No limit. A history table is meant to grow; send it in parts |
| Rows per request | 50,000 (fixed; `/schema` reports it as `maxRowsPerRequest`) |
| Body per request | 64 MB after decompression (fixed). Send `Content-Encoding: gzip`; a 50,000-row JSON body shrinks 5–10× |
| Open full loads per table | 1 (a new `loadId` supersedes) |
| Full-load idle timeout | 60 minutes |

## 8. How it is built

- Tables live in the shared `internal_sources` schema next to the ingested File tables, with the same naming rule, one per table version: `ds_<datasource guid>_<version>`. Columns: `_row bigint identity`, the user's columns (`text`, `numeric`, `date`, `timestamp`, `boolean`), `_version bigint`; a unique index on the key columns.
- Replace = COPY into a new table + atomic swap of the recorded schema; old tables are swept when no run reads them. Upsert = COPY into a temp table + `INSERT … ON CONFLICT (keys) DO UPDATE`. Delete = COPY keys into a temp table + `DELETE … USING`. Realtime = both, in one transaction.
- State is in the data source's `ConnectionConfig` jsonb: `columns`, `sheetSchemas` (the live table, File-shaped so every read path is shared with File sources), `pushKeyHash` (SHA-256; the key itself is never stored), `push` (open load, last version), `pushWatermarks` (per mapping, advanced with `jsonb_set`).
- Auth is the key only (`AuthenticatePushKeyAsync`): constant-time hash compare, then the request is bound to the table's tenant. No session, no cookies.
- Reads (preview, grid, filters, runs) go through the same code as an ingested File source; the only addition is the version window in `DataSourceService.StreamRowsAsync`.

# Part B — Option 3: Planometry pulls from the connector's API

Here the connector is the server. It exposes one HTTPS endpoint per dataset; in Planometry the user creates a **REST API** data source that points at it. Planometry stores nothing: every preview and every mapping run reads the endpoint again, **one page at a time**, and hands each page to the run as it arrives, so a run's memory holds one page however large the feed is.

## 9. The contract in one line

```
GET https://connector.example.com/datasets/gms-hyper-sales?from=2026-01-01&branch=HYPER&limit=10000&cursor=eyJvIjoxMDAwMH0
Authorization: Bearer <key the connector issued>

→ 200
{ "rows": [ { "invoice_no": "INV-1001", "line_no": 1, "qty": 12, "amount": 540.00 }, … ],
  "nextCursor": "eyJvIjoyMDAwMH0" }
```

One URL, one key. Planometry adds `limit` and `cursor` (or `offset`) to the URL the user configured and leaves everything else in it untouched, so the connector's own filter parameters travel with every page. The last page answers `"nextCursor": null`.

## 10. What the connector's API must do

| Requirement | Detail |
| --- | --- |
| Transport | HTTPS, `GET`, JSON response (`Content-Type: application/json`). Response compression is welcome |
| Authentication | A static request header, normally `Authorization: Bearer <key>`. The user pastes it into the data source's **Headers** field in Planometry. Answer `401` for a wrong or missing key |
| Rows | An array of flat objects, one object per row, keys = column names. The same keys on every page. Nested objects and arrays are read as their JSON text, so flatten them |
| Envelope | Put the array under `rows` (or `data` / `items` / `results` / `records`: Planometry finds these by itself; anything else needs the **Data path** field, e.g. `payload.lines`) |
| Columns | Planometry fixes the column set on the **first page**: the union of the keys of its rows. Send every column in every row, with `null` for an empty value, so a column is never missed |
| Values | Text as strings; numbers as JSON numbers or plain numeric strings (no thousands separators); dates as `yyyy-MM-dd`; date-times as ISO 8601. The mapping's transforms do the typing afterwards |
| Stable order | Pages must not overlap or skip. Order by a unique key (the primary key, or a change timestamp plus the key) on every request |
| Errors | A non-2xx status fails the preview or the run with the status shown to the user. Never answer `200` with an error body |

## 11. Pagination

The user picks the mode on the data source. **Cursor is the one to build**; offset exists for APIs that already work that way.

| Mode | Planometry sends | The API answers | The feed ends when |
| --- | --- | --- | --- |
| **Cursor** (recommended) | `limit=N`, and from the second page `cursor=<the previous nextCursor>` | the rows plus `nextCursor` at the top level of the body (a string or number; `next_cursor`, `nextPageToken` and `next` are read too) | `nextCursor` is `null`, empty or missing |
| **Offset** | `limit=N&offset=K` | the rows | a page holds fewer than `N` rows |
| **None** | nothing | every row in one response | after that one response. For small feeds only: the whole body is held in memory |

- `N` is the data source's **Rows per page**: 10,000 by default, at most 50,000.
- The cursor is opaque to Planometry: it is sent back exactly as received. Encode in it whatever the API needs to resume (the last key served is the robust choice; a row offset breaks when rows are inserted mid-read).
- A cursor must stay valid for at least 10 minutes: that is how long Planometry waits for one page before failing the run.
- Planometry stops with a clear error when the API returns the same page twice, the same `nextCursor` twice, or more rows than `limit` in offset mode. Those are the signs of an endpoint that ignores the paging parameters.
- Cursor mode has no random access, so the preview page walks pages from the start to reach a deeper row. Offset mode jumps straight there. A run always reads front to back in either mode.

## 12. Filtering and transforms belong to the API

With a database source Planometry pushes a mapping's source filter into the query, so the database returns only the matching rows. With an API it cannot: the endpoint returns whatever it returns. A mapping's source filter on a REST API source still works, but it is applied **in Planometry, after the rows have arrived**, so every unwanted row is fetched, parsed and then dropped.

So expose the filters the customer needs as query parameters and let the user put them in the URL:

```
https://connector.example.com/datasets/gms-hyper-sales?from=2026-01-01&to=2026-03-31&branch=HYPER
```

- Date range and the main business dimensions (branch, company, ledger) cover almost every case.
- One data source = one URL = one filtered slice. A second slice is a second data source, or the same one with the URL edited.
- Joins, renames, aggregation and unit conversion also belong on the connector's side: Planometry maps the columns it is given.
- A run reads at most 10,000,000 rows from any source. A wider slice fails the run at that point, so filter to what the run needs.

## 13. Setting it up in Planometry, and checking it

1. Create a data source of type **REST API**.
2. **URL**: the endpoint with its filter parameters, without `limit` / `cursor` / `offset`.
3. **Headers**: `{"Authorization": "Bearer <key>"}`.
4. **Pagination**: Cursor (or Offset), and **Rows per page** if 10,000 is not right.
5. **Data path**: only when the row array is not under a name Planometry recognises.
6. Open the preview. **Table** shows the rows as Planometry reads them. **Raw JSON** shows the first page exactly as the run requests it, URL and paging parameters included, capped at 1 MB: that view is the contract check.

| What the user sees | What it means for the API |
| --- | --- |
| `The API answered 401 …` | The key in Headers is wrong or the header name differs |
| `Data path '…' was not found` | The row array is not where the data source says it is |
| `The API returned the same page twice` | `cursor` / `offset` is ignored |
| `The API returned N rows for limit=…` | `limit` is ignored |
| Columns missing in the mapping editor | The first page does not carry that key: send it with `null` |
