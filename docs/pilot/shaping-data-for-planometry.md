# Shaping data for Planometry

Audience: GMS's DBAs. A practical guide to shaping `SummitERP_*` tables
into the two shapes Planometry expects — **hierarchies** and **facts** —
using plain SQL Server views. You don't need to modify any underlying
table; a view that presents the data in the right shape is enough, and
the Nia Agent reads views exactly like tables (see
`docs/plans/planometry-integration.md`'s catalog/contract section).

Every example below is plain SQL Server 2008-compatible T-SQL — no
`TRY_CAST`, `CONCAT`, `FORMAT`, `IIF`, `OFFSET`/`FETCH`, or `STRING_SPLIT`
(all introduced in SQL Server 2012 or later, and unavailable on GMS's
2008 instances). Copy a template below and adapt the column/table names.

## Column types the agent understands

Every column the agent reads is mapped to one of five types — this
determines how its values are read and serialized, so it's worth keeping
in mind while shaping a view:

| Nia type | Typical SQL Server types |
|---|---|
| `text` | `varchar`/`nvarchar`/`char`, `uniqueidentifier`, `xml`, `time` |
| `number` | `int`/`bigint`/`smallint`/`tinyint`, `decimal`/`numeric`/`money`/`float`/`real` |
| `date` | `date` |
| `datetime` | `datetime`/`datetime2`/`smalldatetime`/`datetimeoffset` |
| `boolean` | `bit` |

Numbers and large/precise date-time values are read as exact values
(never rounded through a float) — you don't need to do anything special
for this in a view, it's handled on the agent's side.

## Hierarchies

A hierarchy is **one row per leaf**, with every ancestor level's code and
name as its own pair of columns. Don't emit one row per level — Planometry
expects the full path flattened onto each leaf row.

**Example: a 3-level product hierarchy** (Category → Subcategory →
Product), built from GMS's own category/subcategory/product tables:

```sql
CREATE VIEW dbo.vw_nia_product_hierarchy AS
SELECT
    cat.CategoryCode      AS CategoryCode,
    cat.CategoryName      AS CategoryName,
    sub.SubcategoryCode   AS SubcategoryCode,
    sub.SubcategoryName   AS SubcategoryName,
    prod.ProductCode      AS ProductCode,   -- the leaf
    prod.ProductName      AS ProductName    -- the leaf
FROM dbo.Products AS prod
INNER JOIN dbo.Subcategories AS sub ON sub.SubcategoryId = prod.SubcategoryId
INNER JOIN dbo.Categories AS cat ON cat.CategoryId = sub.CategoryId;
```

Rules of thumb:
- One row per leaf (here, one row per product) — never per
  category/subcategory alone.
- Every level gets exactly two columns: `<Level>Code` and `<Level>Name`.
  Codes should be stable, short identifiers (not an internal surrogate
  key that might get reused); names are the human-readable label.
- A hierarchy with more or fewer levels just repeats this pattern — add
  or drop a `JOIN` and a pair of columns per level.
- If a leaf is missing a level (e.g. an uncategorized product), decide
  with Planometry whether that should be excluded from the view or given
  a placeholder code/name like `UNCATEGORIZED` — don't leave it `NULL`
  silently, since the agent reads `NULL` as "no value," not "root level."

## Facts

A fact row is **leaf codes + one date column + base measures as plain
amounts + a currency code column**. No level names here — just the
leaf-level codes that tie a fact back to its hierarchy/hierarchies, plus
whatever was actually measured.

**Example: daily sales facts**, tying back to the product hierarchy above
plus a customer leaf code:

```sql
CREATE VIEW dbo.vw_nia_sales_facts AS
SELECT
    s.ProductCode         AS ProductCode,     -- leaf code, ties to vw_nia_product_hierarchy
    s.CustomerCode         AS CustomerCode,    -- leaf code, ties to a customer hierarchy
    s.SaleDate             AS SaleDate,        -- one date column
    s.QuantitySold         AS QuantitySold,    -- base measure, plain amount
    s.NetAmount            AS NetAmount,       -- base measure, plain amount
    s.CurrencyCode         AS CurrencyCode     -- currency code column
FROM dbo.SalesTransactions AS s;
```

Rules of thumb:
- **Leaf codes, not level names or surrogate keys** — `ProductCode`
  above, not `ProductId` (an internal integer key) or `CategoryName` (a
  higher level). Planometry joins facts to hierarchies by these leaf
  codes.
- **One date column.** If the source table has several date-ish columns
  (order date, ship date, invoice date), pick the one that's the fact's
  natural date and expose only that one from this view — add a second
  view if a different date grain is genuinely a separate fact.
- **Base measures as plain amounts** — `QuantitySold`, `NetAmount` above.
  Don't pre-aggregate, pre-convert currency, or apply formatting in the
  view; Planometry does its own aggregation once the facts are loaded.
  If the source stores an amount as `money` or `decimal`, that's fine —
  it's read as an exact `number`, never rounded through a float. The same
  goes for the date column: `date`, `datetime`, or `datetime2` all map
  onto a supported Nia type without any conversion needed in the view.
- **A currency code column**, even if every row today is the same
  currency (e.g. always `USD`). This avoids a silent reinterpretation
  later if GMS ever adds a second currency.

## If a source table doesn't line up cleanly

- **Multiple fact grains in one table** (e.g. a transactions table that
  mixes header-level and line-level amounts): create two views, one per
  grain, rather than one view that mixes them.
- **A level with no natural code** (e.g. a free-text region field with no
  formal code list): a view can synthesize one, e.g.
  ```sql
  SELECT
      UPPER(REPLACE(RegionName, ' ', '_')) AS RegionCode,
      RegionName
  FROM dbo.Regions;
  ```
  (`UPPER`/`REPLACE` are both fine on SQL Server 2008 — nothing above
  requires 2012+ syntax.) Confirm the synthesized code is actually unique
  per region before using it.
- **Excluded column types**: `varbinary`, `image`, `geography`,
  `geometry`, `hierarchyid`, and `sql_variant` columns are excluded from
  the catalog entirely (the agent can't map them to any of the five
  types) — if a measure or code is stored as one of these, cast it to a
  supported type inside the view instead of exposing it as-is.

## Getting a view in front of the agent

Once a view exists, it's picked up automatically the next time its
connection's catalog is refreshed — nothing needs to change on the agent
side, since `nia-agent connection test <id>` and `agent doctor` both read
the live catalog, not a cached one. No special registration step for a
new view beyond creating it in the right database.

## See also
- `docs/pilot/gms-install-guide.md` — connection setup.
- `docs/pilot/gms-pilot-runbook.md` — pilot-day sequence.
- `docs/plans/planometry-integration.md` — full contract (`Catalog`,
  `Extract`, `Rows`, `Values` sections) and SQL Server 2008 compatibility
  rules referenced throughout this guide.
