/**
 * Pure decision logic for NodeDrawer.tsx's Table field, extracted so the
 * loading/empty/error priority order is unit-testable without rendering the
 * component (this codebase's vitest config only runs src/lib/**\/*.test.ts,
 * no jsdom/RTL setup — see apps/web/vitest.config.ts's header comment).
 *
 * Bug fix context: entities.length===0 used to be the sole gate deciding
 * between "Loading tables…" and the real picker — which meant a genuinely
 * empty destination database (0 tables, successfully introspected) got
 * stuck on "Loading tables…" forever, and the "+ Create new…" option
 * (inside the now-unreachable picker) never became reachable either. This
 * resolver makes the four states mutually exclusive and gives loading/error
 * a real signal (react-query's isLoading/isError) instead of inferring them
 * from the entities array's length.
 *
 * isError is checked before isLoading (not the reverse): a failed fetch can
 * still report isLoading=true while it's mid-retry, and checking isLoading
 * first would keep showing "Loading tables…" through every retry instead of
 * surfacing the real error message once one exists.
 */
export type TableFieldState =
  | { kind: "select-connection" }
  | { kind: "new-target" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "select" };

export function resolveTableFieldState(args: {
  connectionId: string | undefined;
  newTargetMode: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
}): TableFieldState {
  if (!args.connectionId) return { kind: "select-connection" };
  if (args.newTargetMode) return { kind: "new-target" };
  if (args.isError) return { kind: "error", message: args.errorMessage ?? "Failed to load tables." };
  if (args.isLoading) return { kind: "loading" };
  return { kind: "select" };
}
