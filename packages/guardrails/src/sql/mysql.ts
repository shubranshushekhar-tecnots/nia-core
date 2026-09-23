import type { GuardrailResult, GuardrailValidator } from "../types.js";
import { MYSQL_DIALECT } from "./dialect.js";
import { validateReadOnlySql } from "./validator.js";

export const validateMysqlQuery: GuardrailValidator = (query): GuardrailResult => {
  if (query.kind !== "sql") {
    return { ok: false, reason: `Expected a sql query payload, got kind: ${query.kind}` };
  }
  const result = validateReadOnlySql(query.sql, MYSQL_DIALECT);
  if (!result.ok) return result;
  return {
    ok: true,
    sanitizedQuery: { kind: "sql", sql: result.sanitizedQuery, params: query.params },
  };
};
