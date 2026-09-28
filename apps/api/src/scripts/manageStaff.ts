import { dbPool } from "../lib/dbPool.js";

/**
 * Grants/revokes/lists platform_staff rows (docs/plans/console-plan.md,
 * build order Step 2). The ONLY way platform_staff is ever written — no
 * HTTP route exposes this, per the decided principle "granted/revoked only
 * via a CLI script run by existing staff — never via the app." Runs
 * directly against DATABASE_URL's role (same pattern as
 * seedFixtureUsers.ts/setUserPassword.ts), which already bypasses RLS, so
 * no withServiceRole wrapper is needed here.
 *
 * Bootstrapping the very first staff member: `--granted-by` must always be
 * supplied and is never itself verified to already be staff (there would be
 * no way to grant the first row otherwise) — the operator running this
 * script from a direct DB connection is the actual trust boundary, not
 * anything this script checks.
 *
 *   pnpm --filter @nia/api staff:grant <email> --granted-by <granter-email>
 *   pnpm --filter @nia/api staff:revoke <email>
 *   pnpm --filter @nia/api staff:list
 */

async function findUserIdByEmail(email: string): Promise<string | null> {
  const result = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [email]);
  return result.rows[0]?.id ?? null;
}

async function grant(email: string, grantedByEmail: string | undefined) {
  if (!grantedByEmail) {
    console.error("usage: pnpm --filter @nia/api staff:grant <email> --granted-by <granter-email>");
    process.exit(1);
  }

  const userId = await findUserIdByEmail(email);
  if (!userId) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }
  const grantedById = await findUserIdByEmail(grantedByEmail);
  if (!grantedById) {
    console.error(`no user with email ${grantedByEmail} (--granted-by)`);
    process.exit(1);
  }

  const existing = await dbPool.query<{ revoked_at: string | null }>(
    "select revoked_at from public.platform_staff where user_id = $1",
    [userId],
  );
  if (existing.rows[0] && existing.rows[0].revoked_at === null) {
    console.log(`${email} is already staff (${userId}) — nothing to do`);
    await dbPool.end();
    return;
  }

  // Upsert: a previously-revoked row is re-granted in place (fresh
  // granted_by/granted_at, revoked_at cleared) rather than inserting a
  // second row for the same user_id, since user_id is the primary key.
  await dbPool.query(
    `insert into public.platform_staff (user_id, granted_by, granted_at, revoked_at)
     values ($1, $2, now(), null)
     on conflict (user_id) do update set
       granted_by = excluded.granted_by,
       granted_at = excluded.granted_at,
       revoked_at = null`,
    [userId, grantedById],
  );
  console.log(`granted staff: ${email} (${userId}), granted by ${grantedByEmail} (${grantedById})`);
  await dbPool.end();
}

async function revoke(email: string) {
  const userId = await findUserIdByEmail(email);
  if (!userId) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }

  const result = await dbPool.query(
    "update public.platform_staff set revoked_at = now() where user_id = $1 and revoked_at is null",
    [userId],
  );
  if (result.rowCount === 0) {
    console.log(`${email} is not currently staff — nothing to do`);
  } else {
    console.log(`revoked staff: ${email} (${userId})`);
  }
  await dbPool.end();
}

async function list() {
  const result = await dbPool.query<{
    email: string;
    granted_by_email: string;
    granted_at: string;
    revoked_at: string | null;
  }>(
    `select u.email, g.email as granted_by_email, ps.granted_at, ps.revoked_at
     from public.platform_staff ps
     join public."user" u on u.id = ps.user_id
     join public."user" g on g.id = ps.granted_by
     order by ps.granted_at asc`,
  );
  for (const row of result.rows) {
    const status = row.revoked_at ? `revoked ${row.revoked_at}` : "active";
    console.log(`${row.email}  granted by ${row.granted_by_email} at ${row.granted_at}  [${status}]`);
  }
  await dbPool.end();
}

function parseGrantedBy(args: string[]): string | undefined {
  const flagIndex = args.indexOf("--granted-by");
  return flagIndex >= 0 ? args[flagIndex + 1] : undefined;
}

async function main() {
  const [cmd, email, ...rest] = process.argv.slice(2);
  if (cmd === "grant" && email) {
    await grant(email, parseGrantedBy(rest));
  } else if (cmd === "revoke" && email) {
    await revoke(email);
  } else if (cmd === "list") {
    await list();
  } else {
    console.error("usage:");
    console.error("  pnpm --filter @nia/api staff:grant <email> --granted-by <granter-email>");
    console.error("  pnpm --filter @nia/api staff:revoke <email>");
    console.error("  pnpm --filter @nia/api staff:list");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
