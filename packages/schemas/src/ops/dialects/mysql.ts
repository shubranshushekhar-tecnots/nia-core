import type { SqlDialectAdapter } from "../types.js";
import { makeSqlDialectAdapter } from "./sqlShared.js";

export const mysqlAdapter: SqlDialectAdapter = makeSqlDialectAdapter(
  "mysql",
  (name) => `\`${name.replace(/`/g, "``")}\``,
  () => "?",
);
