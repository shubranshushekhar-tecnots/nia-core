import type { SqlDialectAdapter } from "../types.js";
import { makeSqlDialectAdapter } from "./sqlShared.js";

export const postgresAdapter: SqlDialectAdapter = makeSqlDialectAdapter(
  "postgres",
  (name) => `"${name.replace(/"/g, '""')}"`,
  (index) => `$${index}`,
);
