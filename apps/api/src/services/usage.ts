import type { Queryable } from "@nia/db";

/**
 * Console v2 Slice 4 — service layer for the token usage page + dashboard's
 * token/cost widgets. Every function here takes the already-opened
 * `withServiceRole` connection (consoleUsage.ts's routes open exactly one per
 * request, same convention as console.ts) and does all aggregation in SQL,
 * never in JS, per the task's "Aggregate in SQL, never in JS" rule.
 *
 * Cost is always computed via `costLateralJoin` below: a `LEFT JOIN LATERAL`
 * against `model_prices` picking the row with the latest `effective_from <=
 * u.occurred_at` for that model — i.e. the price actually in effect when the
 * call happened, not today's price. A usage row with no matching price (e.g.
 * a model never priced) contributes 0 cost rather than null, so sums stay
 * well-defined.
 */

export type UsageFilters = {
  dateFrom?: string;
  dateTo?: string;
  orgId?: string;
  model?: string;
  feature?: string;
};

/** Builds a `where` clause (no leading "where") + params for llm_usage filters, starting at $paramOffset. */
function buildWhere(filters: UsageFilters, paramOffset: number): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = paramOffset;

  if (filters.dateFrom) {
    conditions.push(`u.occurred_at >= $${i++}`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push(`u.occurred_at < $${i++}`);
    params.push(filters.dateTo);
  }
  if (filters.orgId) {
    conditions.push(`u.org_id = $${i++}`);
    params.push(filters.orgId);
  }
  if (filters.model) {
    conditions.push(`u.model = $${i++}`);
    params.push(filters.model);
  }
  if (filters.feature) {
    conditions.push(`u.feature = $${i++}`);
    params.push(filters.feature);
  }

  return { clause: conditions.length > 0 ? conditions.join(" and ") : "true", params };
}

/**
 * `LEFT JOIN LATERAL` fragment: for each llm_usage row `u`, picks the single
 * model_prices row effective at `u.occurred_at`, and exposes `p.cost` (a
 * numeric, 0 when no price is known for that model yet).
 */
const costLateralJoin = `
  left join lateral (
    select
      (coalesce(u.input_tokens, 0) / 1000000.0) * mp.input_price_per_1m
      + (coalesce(u.output_tokens, 0) / 1000000.0) * mp.output_price_per_1m
      + (coalesce(u.cached_tokens, 0) / 1000000.0) * coalesce(mp.cached_price_per_1m, 0) as cost
    from public.model_prices mp
    where mp.model = u.model and mp.effective_from <= u.occurred_at
    order by mp.effective_from desc
    limit 1
  ) p on true
`;

export type UsagePeriodStats = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  cost: number;
};

export type UsageSummary = {
  today: UsagePeriodStats;
  month: UsagePeriodStats;
};

function toPeriodStats(row: {
  input_tokens: string | null;
  output_tokens: string | null;
  total_tokens: string | null;
  call_count: string;
  cost: string | null;
}): UsagePeriodStats {
  return {
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    callCount: Number(row.call_count),
    cost: Number(row.cost ?? 0),
  };
}

/** Tokens + cost for today and for the current calendar month, optionally scoped to one org. */
export async function getUsageSummary(db: Queryable, filters: { orgId?: string } = {}): Promise<UsageSummary> {
  const { clause, params } = buildWhere({ orgId: filters.orgId }, 1);

  // Filtered to >= start of month up front (the widest period either stat
  // needs) so the lateral cost join only runs over rows either FILTER could
  // possibly want, then today_*/month_* each narrow further via FILTER.
  const raw = await db.query<{
    today_input_tokens: string | null;
    today_output_tokens: string | null;
    today_total_tokens: string | null;
    today_call_count: string;
    today_cost: string | null;
    month_input_tokens: string | null;
    month_output_tokens: string | null;
    month_total_tokens: string | null;
    month_call_count: string;
    month_cost: string | null;
  }>(
    `select
       sum(u.input_tokens) filter (where u.occurred_at >= date_trunc('day', now())) as today_input_tokens,
       sum(u.output_tokens) filter (where u.occurred_at >= date_trunc('day', now())) as today_output_tokens,
       sum(u.total_tokens) filter (where u.occurred_at >= date_trunc('day', now())) as today_total_tokens,
       count(*) filter (where u.occurred_at >= date_trunc('day', now())) as today_call_count,
       sum(p.cost) filter (where u.occurred_at >= date_trunc('day', now())) as today_cost,
       sum(u.input_tokens) as month_input_tokens,
       sum(u.output_tokens) as month_output_tokens,
       sum(u.total_tokens) as month_total_tokens,
       count(*) as month_call_count,
       sum(p.cost) as month_cost
     from public.llm_usage u
     ${costLateralJoin}
     where ${clause} and u.occurred_at >= date_trunc('month', now())`,
    params,
  );

  const row = raw.rows[0];
  return {
    today: toPeriodStats({
      input_tokens: row?.today_input_tokens ?? null,
      output_tokens: row?.today_output_tokens ?? null,
      total_tokens: row?.today_total_tokens ?? null,
      call_count: row?.today_call_count ?? "0",
      cost: row?.today_cost ?? null,
    }),
    month: toPeriodStats({
      input_tokens: row?.month_input_tokens ?? null,
      output_tokens: row?.month_output_tokens ?? null,
      total_tokens: row?.month_total_tokens ?? null,
      call_count: row?.month_call_count ?? "0",
      cost: row?.month_cost ?? null,
    }),
  };
}

export type UsageTimeseriesPoint = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

/** Daily tokens + cost, grouped by UTC calendar day, matching `filters`. */
export async function getUsageTimeseries(db: Queryable, filters: UsageFilters = {}): Promise<UsageTimeseriesPoint[]> {
  const { clause, params } = buildWhere(filters, 1);

  const result = await db.query<{
    day: string;
    input_tokens: string | null;
    output_tokens: string | null;
    total_tokens: string | null;
    cost: string | null;
  }>(
    `select
       to_char(date_trunc('day', u.occurred_at), 'YYYY-MM-DD') as day,
       sum(u.input_tokens) as input_tokens,
       sum(u.output_tokens) as output_tokens,
       sum(u.total_tokens) as total_tokens,
       sum(p.cost) as cost
     from public.llm_usage u
     ${costLateralJoin}
     where ${clause}
     group by 1
     order by 1`,
    params,
  );

  return result.rows.map((row) => ({
    date: row.day,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    cost: Number(row.cost ?? 0),
  }));
}

export type UsageBreakdownDimension = "org" | "user" | "model" | "feature";

export type UsageBreakdownRow = {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  cost: number;
};

function breakdownGroupSql(by: UsageBreakdownDimension): { select: string; groupBy: string; extraWhere: string; join: string } {
  switch (by) {
    case "org":
      return {
        select: "u.org_id as key, coalesce(o.name, u.org_id::text) as label",
        groupBy: "u.org_id, o.name",
        extraWhere: "u.org_id is not null",
        join: "left join public.organizations o on o.id = u.org_id",
      };
    case "user":
      return {
        select: "u.user_id as key, coalesce(usr.name, usr.email, u.user_id::text) as label",
        groupBy: "u.user_id, usr.name, usr.email",
        extraWhere: "u.user_id is not null",
        join: `left join public."user" usr on usr.id = u.user_id`,
      };
    case "model":
      return { select: "u.model as key, u.model as label", groupBy: "u.model", extraWhere: "true", join: "" };
    case "feature":
      return { select: "u.feature as key, u.feature as label", groupBy: "u.feature", extraWhere: "true", join: "" };
  }
}

/** Tokens + cost grouped by org/user/model/feature, ordered by cost desc, limited to `limit`. */
export async function getUsageBreakdown(
  db: Queryable,
  by: UsageBreakdownDimension,
  filters: UsageFilters = {},
  limit = 20,
): Promise<UsageBreakdownRow[]> {
  const { select, groupBy, extraWhere, join } = breakdownGroupSql(by);
  const { clause, params } = buildWhere(filters, 1);

  const result = await db.query<{
    key: string;
    label: string;
    input_tokens: string | null;
    output_tokens: string | null;
    total_tokens: string | null;
    call_count: string;
    cost: string | null;
  }>(
    `select
       ${select},
       sum(u.input_tokens) as input_tokens,
       sum(u.output_tokens) as output_tokens,
       sum(u.total_tokens) as total_tokens,
       count(*) as call_count,
       sum(p.cost) as cost
     from public.llm_usage u
     ${join}
     ${costLateralJoin}
     where ${clause} and ${extraWhere}
     group by ${groupBy}
     order by cost desc nulls last
     limit $${params.length + 1}`,
    [...params, limit],
  );

  return result.rows.map((row) => ({
    key: row.key,
    label: row.label,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    callCount: Number(row.call_count),
    cost: Number(row.cost ?? 0),
  }));
}

export type TopConsumers = {
  topOrgs: UsageBreakdownRow[];
  topUsers: UsageBreakdownRow[];
};

/** Top-N orgs and users by cost, matching `filters` (date range / model / feature). */
export async function getTopConsumers(db: Queryable, filters: UsageFilters = {}, limit = 10): Promise<TopConsumers> {
  const [topOrgs, topUsers] = await Promise.all([
    getUsageBreakdown(db, "org", filters, limit),
    getUsageBreakdown(db, "user", filters, limit),
  ]);
  return { topOrgs, topUsers };
}

export type ModelPrice = {
  id: string;
  model: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cachedPricePer1m: number | null;
  currency: string;
  effectiveFrom: string;
  createdBy: string | null;
  createdAt: string;
};

function toModelPrice(row: {
  id: string;
  model: string;
  input_price_per_1m: string;
  output_price_per_1m: string;
  cached_price_per_1m: string | null;
  currency: string;
  effective_from: string;
  created_by: string | null;
  created_at: string;
}): ModelPrice {
  return {
    id: row.id,
    model: row.model,
    inputPricePer1m: Number(row.input_price_per_1m),
    outputPricePer1m: Number(row.output_price_per_1m),
    cachedPricePer1m: row.cached_price_per_1m === null ? null : Number(row.cached_price_per_1m),
    currency: row.currency,
    effectiveFrom: row.effective_from,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Full price history (newest effective_from first), optionally filtered to one model. */
export async function listModelPrices(db: Queryable, model?: string): Promise<ModelPrice[]> {
  const result = await db.query<{
    id: string;
    model: string;
    input_price_per_1m: string;
    output_price_per_1m: string;
    cached_price_per_1m: string | null;
    currency: string;
    effective_from: string;
    created_by: string | null;
    created_at: string;
  }>(
    `select id, model, input_price_per_1m, output_price_per_1m, cached_price_per_1m, currency, effective_from, created_by, created_at
     from public.model_prices
     where ($1::text is null or model = $1)
     order by model, effective_from desc`,
    [model ?? null],
  );
  return result.rows.map(toModelPrice);
}

export type CreateModelPriceInput = {
  model: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cachedPricePer1m?: number;
  currency?: string;
  effectiveFrom?: string;
};

/** Inserts a new price row — a "correction" is just a new row with a later effective_from, never an update (history kept). */
export async function createModelPrice(db: Queryable, input: CreateModelPriceInput, createdBy: string): Promise<ModelPrice> {
  const result = await db.query<{
    id: string;
    model: string;
    input_price_per_1m: string;
    output_price_per_1m: string;
    cached_price_per_1m: string | null;
    currency: string;
    effective_from: string;
    created_by: string | null;
    created_at: string;
  }>(
    `insert into public.model_prices (model, input_price_per_1m, output_price_per_1m, cached_price_per_1m, currency, effective_from, created_by)
     values ($1, $2, $3, $4, coalesce($5, 'USD'), coalesce($6, now()), $7)
     returning id, model, input_price_per_1m, output_price_per_1m, cached_price_per_1m, currency, effective_from, created_by, created_at`,
    [
      input.model,
      input.inputPricePer1m,
      input.outputPricePer1m,
      input.cachedPricePer1m ?? null,
      input.currency ?? null,
      input.effectiveFrom ?? null,
      createdBy,
    ],
  );
  return toModelPrice(result.rows[0]!);
}

/** Minimal CSV field escaping: wraps in quotes and doubles any embedded quote whenever the field contains a comma, quote, or newline. */
export function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Builds a CSV document (header row + one row per record) from an array of same-shaped objects. */
export function toCsv(rows: Array<Record<string, string | number>>, columns: string[]): string {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map((row) => columns.map((col) => csvEscape(String(row[col] ?? ""))).join(","));
  return [header, ...body].join("\n");
}
