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
 * Every grant/revoke (other than bootstrap) must name an ACTIVE staff
 * member via --by, who is recorded as granted_by/revoked_by — this script
 * verifies that membership itself (queries platform_staff), it does not
 * just trust the string. The one exception is bootstrapping the very first
 * staff member: `grant <email> --bootstrap` self-grants (granted_by =
 * the same user being granted) and refuses outright if any active staff
 * row already exists, since at that point --by should be used instead.
 *
 *   pnpm --filter @nia/api staff:grant <email> --by <active-staff-email>
 *   pnpm --filter @nia/api staff:grant <email> --bootstrap   (only once, when no active staff exists yet)
 *   pnpm --filter @nia/api staff:revoke <email> --by <active-staff-email>
 *   pnpm --filter @nia/api staff:list
 *
 * Note: this script does not yet write to staff_audit_log — that table and
 * the audit-write are console-plan.md build order Step 3, not this one.
 */

async function findUserIdByEmail(email: string): Promise<string | null> {
  const result = await dbPool.query<{ id: string }>('select id from "user" where email = $1', [email]);
  return result.rows[0]?.id ?? null;
}

async function countActiveStaff(): Promise<number> {
  const result = await dbPool.query<{ count: number }>(
    "select count(*)::int as count from public.platform_staff where revoked_at is null",
  );
  return result.rows[0]?.count ?? 0;
}

/** Resolves `email` to a user id, exiting the process unless that user currently has an active platform_staff row. */
async function requireActiveStaffByEmail(email: string, flagLabel: string): Promise<string> {
  const result = await dbPool.query<{ id: string }>(
    `select u.id from public."user" u
     join public.platform_staff ps on ps.user_id = u.id
     where u.email = $1 and ps.revoked_at is null`,
    [email],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    console.error(`${email} (${flagLabel}) is not an active staff member`);
    process.exit(1);
  }
  return id;
}

async function grant(email: string, byEmail: string | undefined, bootstrap: boolean) {
  if (bootstrap && byEmail) {
    console.error("usage: --bootstrap and --by are mutually exclusive (bootstrap self-grants)");
    process.exit(1);
  }
  if (!bootstrap && !byEmail) {
    console.error("usage: pnpm --filter @nia/api staff:grant <email> --by <active-staff-email>");
    console.error("   or: pnpm --filter @nia/api staff:grant <email> --bootstrap   (only if no active staff exists yet)");
    process.exit(1);
  }

  const userId = await findUserIdByEmail(email);
  if (!userId) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }

  let granterId: string;
  if (bootstrap) {
    const activeCount = await countActiveStaff();
    if (activeCount > 0) {
      console.error(`--bootstrap refused: ${activeCount} active staff member(s) already exist — use --by instead`);
      process.exit(1);
    }
    granterId = userId; // self-granted — there is no existing staff member to attribute this to
  } else {
    granterId = await requireActiveStaffByEmail(byEmail!, "--by");
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
  // granted_by/granted_at, revoked_at/revoked_by cleared) rather than
  // inserting a second row for the same user_id, since user_id is the
  // primary key.
  await dbPool.query(
    `insert into public.platform_staff (user_id, granted_by, granted_at, revoked_at, revoked_by)
     values ($1, $2, now(), null, null)
     on conflict (user_id) do update set
       granted_by = excluded.granted_by,
       granted_at = excluded.granted_at,
       revoked_at = null,
       revoked_by = null`,
    [userId, granterId],
  );
  const via = bootstrap ? "bootstrap (self-granted)" : `by ${byEmail} (${granterId})`;
  console.log(`granted staff: ${email} (${userId}), granted ${via}`);
  await dbPool.end();
}

async function revoke(email: string, byEmail: string | undefined) {
  if (!byEmail) {
    console.error("usage: pnpm --filter @nia/api staff:revoke <email> --by <active-staff-email>");
    process.exit(1);
  }

  const userId = await findUserIdByEmail(email);
  if (!userId) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }
  const revokerId = await requireActiveStaffByEmail(byEmail, "--by");

  const result = await dbPool.query(
    "update public.platform_staff set revoked_at = now(), revoked_by = $2 where user_id = $1 and revoked_at is null",
    [userId, revokerId],
  );
  if (result.rowCount === 0) {
    console.log(`${email} is not currently staff — nothing to do`);
  } else {
    console.log(`revoked staff: ${email} (${userId}), revoked by ${byEmail} (${revokerId})`);
  }
  await dbPool.end();
}

async function list() {
  const result = await dbPool.query<{
    email: string;
    granted_by_email: string;
    granted_at: string;
    revoked_at: string | null;
    revoked_by_email: string | null;
  }>(
    `select u.email, g.email as granted_by_email, ps.granted_at, ps.revoked_at, r.email as revoked_by_email
     from public.platform_staff ps
     join public."user" u on u.id = ps.user_id
     join public."user" g on g.id = ps.granted_by
     left join public."user" r on r.id = ps.revoked_by
     order by ps.granted_at asc`,
  );
  for (const row of result.rows) {
    const status = row.revoked_at ? `revoked ${row.revoked_at} by ${row.revoked_by_email ?? "?"}` : "active";
    console.log(`${row.email}  granted by ${row.granted_by_email} at ${row.granted_at}  [${status}]`);
  }
  await dbPool.end();
}

function parseFlag(args: string[], flag: string): string | undefined {
  const flagIndex = args.indexOf(flag);
  return flagIndex >= 0 ? args[flagIndex + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function main() {
  const [cmd, email, ...rest] = process.argv.slice(2);
  if (cmd === "grant" && email) {
    await grant(email, parseFlag(rest, "--by"), hasFlag(rest, "--bootstrap"));
  } else if (cmd === "revoke" && email) {
    await revoke(email, parseFlag(rest, "--by"));
  } else if (cmd === "list") {
    await list();
  } else {
    console.error("usage:");
    console.error("  pnpm --filter @nia/api staff:grant <email> --by <active-staff-email>");
    console.error("  pnpm --filter @nia/api staff:grant <email> --bootstrap");
    console.error("  pnpm --filter @nia/api staff:revoke <email> --by <active-staff-email>");
    console.error("  pnpm --filter @nia/api staff:list");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
