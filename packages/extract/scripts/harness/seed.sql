IF DB_ID('nia_extract_test') IS NULL
  CREATE DATABASE nia_extract_test;
GO
USE nia_extract_test;
GO

CREATE SCHEMA reporting;
GO

CREATE TABLE dbo.widgets (
  id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(100) NOT NULL,
  notes VARCHAR(200) NULL,
  is_active BIT NOT NULL,
  price DECIMAL(18,2) NOT NULL,
  exact_decimal DECIMAL(38,10) NOT NULL,
  cash MONEY NOT NULL,
  big BIGINT NOT NULL,
  event_date DATE NOT NULL,
  created_at DATETIME2(7) NOT NULL,
  created_at_offset DATETIMEOFFSET(7) NOT NULL,
  legacy_dt DATETIME NOT NULL,
  small_dt SMALLDATETIME NOT NULL,
  duration TIME(7) NOT NULL,
  ratio FLOAT NOT NULL,
  uid UNIQUEIDENTIFIER NOT NULL,
  payload XML NULL,
  [weird]]bracket] NVARCHAR(50) NULL
);
GO

INSERT INTO dbo.widgets
  (name, notes, is_active, price, exact_decimal, cash, big, event_date, created_at, created_at_offset, legacy_dt, small_dt, duration, ratio, uid, payload, [weird]]bracket])
VALUES
  ('alpha', 'has a % percent and _ underscore literal', 1, 19.99, 1234567890123456789012345678.1234567890, 1234567890.1234, 9223372036854775807, '2024-06-15', '2024-03-01T10:30:00.1234567', '2024-03-01T10:30:00.1234567+05:30', '2024-06-15T08:00:00.000', '2024-06-15T08:00:00', '13:45:30.1234567', 3.14159, NEWID(), '<a>1</a>', 'bracket]value'),
  ('beta', NULL, 0, 0.00, 0, 0, 0, '2024-01-01', '2024-01-01T00:00:00.0000000', '2024-01-01T00:00:00.0000000+00:00', '2024-01-01T00:00:00.000', '2024-01-01T00:00:00', '00:00:00.0000000', 0, NEWID(), NULL, NULL),
  ('disc%ount_promo', 'literal wildcard chars in the value itself', 1, 5.00, 0.0000000001, 0.0001, -9223372036854775808, '2024-07-04', '2024-07-04T12:00:00.0000001', '2024-07-04T12:00:00.0000001-08:00', '2024-07-04T12:00:00.000', '2024-07-04T12:00:00', '23:59:59.9999999', -1.5, NEWID(), NULL, NULL);
GO

-- Exact-value exercise columns live in dbo.widgets above; this table
-- exists only to exercise catalog exclusion of unsupported native types.
CREATE TABLE dbo.excluded_probe (
  id INT IDENTITY(1,1) PRIMARY KEY,
  allowed_text NVARCHAR(50) NOT NULL,
  blob VARBINARY(100) NULL,
  legacy_blob IMAGE NULL,
  geo GEOGRAPHY NULL,
  geom GEOMETRY NULL,
  tree HIERARCHYID NULL,
  variant SQL_VARIANT NULL
);
GO
INSERT INTO dbo.excluded_probe (allowed_text) VALUES ('still readable');
GO

-- Schema-qualified name coverage (non-dbo schema).
CREATE TABLE reporting.sales (
  id INT IDENTITY(1,1) PRIMARY KEY,
  amount DECIMAL(10,2) NOT NULL
);
GO
INSERT INTO reporting.sales (amount) VALUES (100.00), (250.50);
GO

-- Slice T2, apps/web/e2e/agentRoute1.spec.ts step a) — 10,000 rows (2,000
-- orders x 5 line items each) with a genuine two-column composite PRIMARY
-- KEY (order_id, line_no), to exercise packages/extract's composite-key
-- keyset read end to end against a real multi-column cursor, not a
-- degenerate one-column-constant stand-in. Generated set-based (fast),
-- same L0..L4 doubling trick as dbo.big_table below.
WITH L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
L1 AS (SELECT 1 AS c FROM L0 A CROSS JOIN L0 B),
L2 AS (SELECT 1 AS c FROM L1 A CROSS JOIN L1 B),
L3 AS (SELECT 1 AS c FROM L2 A CROSS JOIN L2 B),
L4 AS (SELECT 1 AS c FROM L3 A CROSS JOIN L3 B),
Orders AS (SELECT TOP (2000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS order_id FROM L4),
Lines AS (SELECT TOP (5) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS line_no FROM L4)
SELECT o.order_id, l.line_no,
       CONCAT('item-', o.order_id, '-', l.line_no) AS item_name,
       CAST(o.order_id * 10 + l.line_no AS DECIMAL(10,2)) AS amount
INTO dbo.order_lines
FROM Orders o CROSS JOIN Lines l;
GO
-- Same SELECT INTO nullability quirk as dbo.big_table below.
ALTER TABLE dbo.order_lines ALTER COLUMN order_id INT NOT NULL;
GO
ALTER TABLE dbo.order_lines ALTER COLUMN line_no INT NOT NULL;
GO
ALTER TABLE dbo.order_lines ADD CONSTRAINT pk_order_lines PRIMARY KEY (order_id, line_no);
GO

-- 1M+ row table, generated set-based (fast: a few seconds, no
-- row-by-row inserts).
WITH L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
L1 AS (SELECT 1 AS c FROM L0 A CROSS JOIN L0 B),
L2 AS (SELECT 1 AS c FROM L1 A CROSS JOIN L1 B),
L3 AS (SELECT 1 AS c FROM L2 A CROSS JOIN L2 B),
L4 AS (SELECT 1 AS c FROM L3 A CROSS JOIN L3 B),
Nums AS (SELECT TOP (1200000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM L4 A CROSS JOIN L3 B)
SELECT n AS id, CONCAT('row-', n) AS label, n * 1.5 AS val
INTO dbo.big_table
FROM Nums;
GO
-- SELECT INTO infers "id" as nullable (ROW_NUMBER()'s result type isn't
-- propagated as NOT NULL), so a PRIMARY KEY can't be added until it's
-- explicitly tightened.
ALTER TABLE dbo.big_table ALTER COLUMN id INT NOT NULL;
GO
ALTER TABLE dbo.big_table ADD CONSTRAINT pk_big_table PRIMARY KEY (id);
GO

-- Deliberately slow "view": WAITFOR DELAY is not permitted inside a
-- view or function body in SQL Server (confirmed against Microsoft
-- docs/forums), so this instead forces several seconds of real CPU
-- work (sorting/counting 40M generated rows) before the first output
-- row can be produced. Same observable effect for the mandatory
-- test's purpose (prove keep-alives fire while waiting for the first
-- row, then the row streams correctly) without procedural code. 40M
-- (not 4M) deliberately: on this harness's hardware 4M only took
-- ~1s end-to-end, too fast for NdjsonWriter's keep-alive checker
-- (fires on a fixed 1s tick) to reliably get even one chance to run
-- before the single row already arrived — 40M reliably takes several
-- seconds.
CREATE VIEW dbo.vw_slow AS
WITH L0 AS (SELECT 1 AS c UNION ALL SELECT 1),
L1 AS (SELECT 1 AS c FROM L0 A CROSS JOIN L0 B),
L2 AS (SELECT 1 AS c FROM L1 A CROSS JOIN L1 B),
L3 AS (SELECT 1 AS c FROM L2 A CROSS JOIN L2 B),
L4 AS (SELECT 1 AS c FROM L3 A CROSS JOIN L3 B),
Slow AS (SELECT TOP (40000000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM L4 A CROSS JOIN L4 B)
SELECT CAST(COUNT_BIG(*) AS INT) AS row_count, CAST(MAX(n) AS BIGINT) AS max_n
FROM Slow;
GO
