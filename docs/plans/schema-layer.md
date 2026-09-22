Schema layer plan: any source (SQL, NoSQL, files) to any destination (SQL, NoSQL), with destination structures created automatically.
First, save this entire prompt verbatim to docs/plans/schema-layer.md and re-read it if your context is compacted. Move fast; keep tests to exactly the listed ones. Don't commit.

Core idea: every connector translates its native types to and from one closed logical type system (NiaType), the same way the op catalog defines semantics and adapters comply. N sources + M destinations need N + M mappings, not N × M.

Step 0: Confirm the working tree is clean apart from the known landing-page work. STOP otherwise.

Step 1: Inventory (short report, then continue)
- The existing column-mapping feature (smoke:mapping): how source fields map to destination columns today, and how values are converted on write.
- What happens today when a Mongo document with a nested object or array is written to mysql or postgres. If it's stored as "[object Object]" or fails, report it as a found bug.
- How the CSV/Excel upload source exposes its schema.
- What the profiler records for Mongo fields today: top-level only, or nested paths.
STOP if the existing mapping feature conflicts with the design below in a way that isn't a straightforward extension.

Part 1: NiaType and adapter mappings
- NiaType (closed): string (optional format: uuid, objectId), integer, float, decimal (optional precision/scale), boolean, date, timestamp (tz: utc | naive), bytes, json, object { fields }, array<T>. Every field carries nullable; inferred fields also carry presence (the fraction of records that have the field).
- Type join, used wherever types meet: integer ⊔ float = float; integer or float ⊔ decimal = decimal; date ⊔ timestamp = timestamp; object ⊔ object = merged fields; array<A> ⊔ array<B> = array<A ⊔ B>; anything ⊔ null = nullable. A join that falls back to string (e.g. integer ⊔ string) or json (object ⊔ scalar) is marked degraded.
- Each dialect adapter declares both directions, native → NiaType (sources) and NiaType → native (destinations), each marked lossless or lossy with a reason.
  - Postgres: jsonb for json/object/array; native uuid.
  - MySQL: JSON; CHAR(36) for uuid; VARCHAR(255) for string keys; DECIMAL(p,s) when precision is known, otherwise DOUBLE.
  - Mongo: native types; decimal → Decimal128 or double.
- Declared SQL source schemas become NiaSchemas through these mappings.

Part 2: Inferred schemas
- For Mongo sources and file uploads, build a NiaSchema from the profiler sample: every field path including nested ones, the join of observed types per path, and presence. Extend the profiler to record nested paths and per-path type counts if it doesn't already.
- Include field paths and their types in the profile signature, so the existing drift check catches new fields.
Checkpoint: stop after Part 2 and report, so I can review and commit.

Part 3: Schema through the pipeline
- Each op module declares outputSchema(input, step) through the op registry, as it declares pushability. typeOfExpr returns NiaTypes. If an output type can't be determined, fail naming the column; never guess.
- Two new ops: to_json(x) turns any value into json, and flatten(field, maxDepth) turns an object's fields into prefixed columns. Declare both non-pushable on every dialect for now (residual-only). Add pushdown for them to TODO.md.

Part 4: Destination contract
- One contract per destination: the target, and per column: source path, destination name, NiaType, native type, fidelity (lossless / lossy + reason / degraded), and key flag. Plus a strategy per nested field (json by default, or flatten) and an unknown-field policy (count, the default, or fail).
- Default shapes: nested → SQL gives one json column per nested field; flat → Mongo gives one document per row; Mongo → Mongo and SQL → SQL keep their shape.
- Names: one deterministic normalizer per destination covering allowed characters and max length. Flattened paths join with _, collisions get a suffix, truncated names get a short hash. For Mongo, no '.' and no leading '$'. Show the result in the preview.
- Creation: new structured WriteRequest operations createTable / createCollection / createIndex. The signed WriteContext names the target, and connectors build from fixed templates. Keys become the primary key or a unique index. If anon/authenticated roles exist, enable RLS on created tables. Runs in preflight, before staging.
- Existing targets: read their structure back into a NiaSchema and compare it with the contract. On mismatch, refuse and list the differences. Never ALTER or drop an existing table automatically.
- The contract's hash joins the CleanPlan bindings. For manual pipelines, store it on the destination node.
- UI: on the destination node, choose an existing target or type a new name. The preview shows source path → destination name → type, a fidelity badge, and a JSON/flatten toggle per nested field. Degraded fields are highlighted, and the router sends them to the coercion specialist.

Part 5: Run-time conformance
- A final implicit step casts each value to its contract type, with the existing coercion functions' semantics. It's fallible: onFailure defaults to quarantine, with counts and maxFailureRate like any fallible step. Skip it for columns whose source and contract types already match.
- Fields not in the contract follow the unknown-field policy and are counted in the run result. Never drop them silently.

Tests (exactly these, nothing more)
- Unit: the type join, including the degraded cases.
- Unit: one table-driven test covering every adapter's mappings in both directions.
- Unit: inference from a sample with a nested object, an array, a mixed-type field, and a field present in only some documents, plus name normalization with one collision.
- One smoke: mongo with nested documents → new postgres table. Assert the created column types, that nested values arrive as valid JSON, and that a value not matching its contract type is quarantined.
- Typecheck and the unit suites of changed packages. No full suites.

Close
- docs/decisions.md: a short schema-layer entry covering NiaType, the join, fidelity rules, contracts, and why existing tables are never altered.
- TODO.md: additive schema evolution proposed as a PlanDiff; arrays of objects into child tables; composite keys; Mongo $jsonSchema validators; lossless decimals; pushdown for to_json and flatten.
- SCHEMA_LAYER_EXIT.md: short.

Output: inventory findings, deviations with reasons, test counts, and the untruncated git status --porcelain. Don't commit.

Plan update (Mongo destination un-flattening, pre-Part-3 fix)
- connector-mongodb already flattens on read: nested plain objects become dotted-path columns (`{a:{b:1}} -> "a.b"`), arrays never descend and stay JSON.stringify'd "json"-typed columns. This predates Part 4's contract work and needed a symmetric write-side fix now rather than waiting for the full destination-contract machinery.
- For Mongo destinations, /write now un-flattens: each column name is split on "." and rebuilt into a nested document (services/connector-mongodb/src/writeOps.ts's unflattenDoc/setNestedPath), and any string value that parses as a JSON array is reparsed back into a real array (maybeParseJsonArray) — narrow by design, mirroring flatten.ts's own narrow "only arrays get stringified" rule, so a legitimate string column that happens to look like JSON (e.g. "123") is left alone. This makes Mongo -> Mongo round-trip the same document shape.
- Degraded columns: a source field name that itself contains a literal "." is ambiguous with the dotted-path nesting convention (can't tell `{"a.b":1}` from `{a:{b:1}}` once both produce column name "a.b"). flatten.ts now flags this case instead of guessing: it stops descending into that key's subtree, treats it as an opaque leaf (JSON.stringify'd if array/object, raw if scalar), and adds it to a new `degradedColumns` set. This is surfaced as a `degraded: boolean` field on `Column` (packages/schemas/src/tabular.ts, used by every connector's /execute TabularResult) and on `IntrospectResponse.entities[].fields` (packages/schemas/src/contract.ts) — both default to unset/false for every connector with no such ambiguity (the SQL dialects).
- Known, accepted limitation: `WriteRequest` carries no column-type or degraded metadata (same gap as Part 2's json round-tripping fix for the SQL connectors) — the write-side un-flatten is a mechanical, unconditional split-on-"." inversion and cannot skip a column that was flagged degraded at read time. The `degraded` flag's value is entirely at read/profile time (for a mapping UI to avoid guessing a nested shape from an ambiguous name); fixing this at write time would require threading degraded-ness through the signed WriteContext, which is out of scope here and deferred to Part 4's destination contract (which already carries a fidelity/degraded flag per column).
- Tests: services/connector-mongodb/src/flatten.test.ts (degraded-flagging cases) and the new services/connector-mongodb/src/writeOps.test.ts (un-flatten + array-reparse cases).
