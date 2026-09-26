/**
 * docs/plans/pooler-write-grant.md — Supabase's session pooler (Supavisor,
 * `*.pooler.supabase.com`) multiplexes many projects behind one host/port,
 * so it needs a tenant identifier on every connection. It gets that from
 * the username itself: the wire username must be `<role>.<project_ref>`,
 * not the bare Postgres role name — Supavisor strips the `.<project_ref>`
 * suffix before authenticating against the real role. Connecting with a
 * bare role name against a pooler host fails with
 * `(ENOIDENTIFIER) no tenant identifier provided (external_id or
 * sni_hostname required)`.
 *
 * A direct-connection host (`db.<ref>.supabase.co`) has no such
 * requirement — this module only ever touches pooler hosts.
 */

const POOLER_HOST_PATTERN = /(\.|^)pooler\.supabase\.com$/i;

export function isSupabasePoolerHost(host: string): boolean {
  return POOLER_HOST_PATTERN.test(host);
}

/**
 * A source/read connection's username is free-text, typed by the user when
 * they set up the connection — if they used Supabase's own pooler
 * connection string, it already comes qualified as `<role>.<project_ref>`
 * (e.g. `postgres.abcdefghijkl`), same as `extractProjectRef` below reads
 * back out. A write-grant role, by contrast, is minted by this codebase
 * (NodeDrawer.tsx's `randomWriteRoleUser`) as a bare name with no ref —
 * that's the credential this function exists to qualify.
 */
export function extractProjectRef(user: string): string | undefined {
  const dotIndex = user.indexOf(".");
  return dotIndex === -1 ? undefined : user.slice(dotIndex + 1);
}

/**
 * Returns the username to actually connect with. Non-pooler hosts and
 * already-qualified usernames (containing a ".") pass through unchanged —
 * the latter covers the common case of a user-typed source/read username
 * that already carries its project ref, so this is safe to call for every
 * pool, not just newly-minted write roles.
 *
 * Throws (rather than silently connecting with a bare username, which
 * Supavisor would reject anyway with an opaque ENOIDENTIFIER) when the host
 * is a pooler host, the username isn't already qualified, and no
 * `projectRef` was supplied to qualify it with.
 */
export function resolvePoolerUsername(user: string, host: string, projectRef: string | undefined): string {
  if (!isSupabasePoolerHost(host)) return user;
  if (user.includes(".")) return user;
  if (!projectRef) {
    throw new Error(
      `Cannot connect to the Supabase pooler as "${user}": no project ref could be determined. ` +
        `Use the pooler connection string's username, formatted "<role>.<project_ref>", when setting up this connection.`,
    );
  }
  return `${user}.${projectRef}`;
}
