/**
 * Re-executes a citation's `executedQuery` through the exact same
 * dispatch() chokepoint every real query goes through (resolveConnection ->
 * validateBeforeDispatch -> sendToConnector -> audit), and confirms it
 * reproduces the same row count — proof the cited number wasn't a one-off
 * fluke. This is the automated half of Phase 4 Task 3's citation-
 * reproduction requirement.
 *
 * executedQuery is plain, connector-readable text (see TabularMeta's
 * header comment): raw SQL for mysql/supabase (connector-mysql/supabase's
 * `meta.executedQuery = body.query.sql`), or
 * `db.<collection>.aggregate(<pipeline JSON>)` for mongo
 * (connector-mongodb's index.ts). Reparsing it back into a QueryPayload is
 * possible ONLY because that format is stable and self-describing — this
 * is not a general SQL/Mongo parser, just the inverse of those two exact
 * connector-side formatters.
 */
import type { QueryPayload } from "@nia/schemas";
import { dispatch } from "../dispatch.js";
import type { WorkspaceScope } from "../workspaceScope.js";

const MONGO_EXECUTED_QUERY = /^db\.([^.]+)\.aggregate\((.*)\)$/s;

export function reparseExecutedQuery(executedQuery: string): QueryPayload | undefined {
  const mongoMatch = MONGO_EXECUTED_QUERY.exec(executedQuery);
  if (mongoMatch) {
    try {
      const pipeline = JSON.parse(mongoMatch[2]!) as Record<string, unknown>[];
      return { kind: "mongo", collection: mongoMatch[1]!, pipeline };
    } catch {
      return undefined;
    }
  }
  return { kind: "sql", sql: executedQuery, params: [] };
}

export type CitationReproductionResult = {
  connectionId: string;
  reproduced: boolean;
  originalRowCount: number;
  reproducedRowCount?: number;
  error?: string;
};

export async function reproduceCitation(
  citation: { connectionId: string; executedQuery: string; rowCount: number },
  scope: WorkspaceScope,
  actorUserId: string,
): Promise<CitationReproductionResult> {
  const query = reparseExecutedQuery(citation.executedQuery);
  if (!query) {
    return { connectionId: citation.connectionId, reproduced: false, originalRowCount: citation.rowCount, error: "could not reparse executedQuery" };
  }
  const result = await dispatch(citation.connectionId, query, scope, actorUserId);
  if (!result.ok) {
    return { connectionId: citation.connectionId, reproduced: false, originalRowCount: citation.rowCount, error: result.error.message };
  }
  const reproducedRowCount = result.value.meta.rowCount;
  return {
    connectionId: citation.connectionId,
    reproduced: reproducedRowCount === citation.rowCount,
    originalRowCount: citation.rowCount,
    reproducedRowCount,
  };
}
