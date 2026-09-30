import { afterAll, describe, expect, it } from "vitest";
import { withActingUser } from "@nia/db";
import { dbPool } from "./dbPool.js";

/**
 * Subscription Phase 2, Slice 4 ("invite links + accept flow") —
 * supabase/migrations/0058_invite_links.sql's create_invite/revoke_invite/
 * accept_invite RPCs, exercised as real acting users (withActingUser sets
 * `SET LOCAL ROLE authenticated` + the request.jwt.claims GUC per
 * transaction — packages/db/src/client.ts) against real local Postgres, the
 * same way apps/web/src/lib/invites/actions.ts calls them.
 *
 * Two fixture users stand in for "org owner" and "person being invited" —
 * canvas-e2e-a/-b/-c@nia.dev (apps/api/src/scripts/seedFixtureUsers.ts).
 * Each test creates its own brand-new org so an acceptor is never
 * incidentally already a member of the org under test.
 *
 * Real local Postgres only (apps/api/.env's DATABASE_URL). Run explicitly
 * with `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 */

afterAll(async () => {
  await dbPool.end();
});

async function fixtureUserId(email: string): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>('select id from public."user" where email = $1', [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`fixture user ${email} not found — run \`pnpm --filter @nia/api seed:fixtures\` first`);
  return id;
}

async function makeOrg(ownerId: string): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    ["invites test org", `invites-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, ownerId],
  );
  const orgId = rows[0]!.id;
  await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'owner')", [
    orgId,
    ownerId,
  ]);
  return orgId;
}

async function dropOrg(orgId: string): Promise<void> {
  // makeOrg() (unlike the raw-org-only fixtures other integration tests in
  // this directory use) also inserts a real organization_members 'owner'
  // row — deleting the org cascades into deleting that row, which trips
  // private.protect_last_super_admin's "cannot remove the last owner"
  // guard (an unconditional BEFORE DELETE trigger, fires regardless of
  // role). Disabling it for this one cleanup statement, as the table
  // owner, then re-enabling it immediately, is the same pattern
  // orgPlan.integration.test.ts's own cleanup uses for this exact case.
  await dbPool.query("alter table public.organization_members disable trigger organization_members_protect_last_super_admin");
  try {
    await dbPool.query("delete from public.organizations where id = $1", [orgId]);
  } finally {
    await dbPool.query("alter table public.organization_members enable trigger organization_members_protect_last_super_admin");
  }
}

function createInvite(
  actingUserId: string,
  args: {
    orgId: string;
    role?: string;
    tokenHash: string;
    expiresAt?: Date;
    maxUses?: number | null;
    emailDomain?: string | null;
  },
) {
  return withActingUser(dbPool, actingUserId, (db) =>
    db.query<{ id: string }>(
      // `select * from` (not `select public.create_invite(...) as x`) so
      // the composite public.invite_links return type flattens into real
      // columns — pg doesn't parse Postgres composite-literal strings back
      // into objects on its own.
      "select * from public.create_invite($1, $2, $3, $4, $5, $6)",
      [
        args.orgId,
        args.role ?? "member",
        args.tokenHash,
        (args.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)).toISOString(),
        args.maxUses ?? null,
        args.emailDomain ?? null,
      ],
    ),
  );
}

function acceptInvite(actingUserId: string, tokenHash: string) {
  return withActingUser(dbPool, actingUserId, (db) =>
    db.query<{ org_id: string; org_name: string; org_slug: string; role: string; already_member: boolean }>(
      "select * from public.accept_invite($1)",
      [tokenHash],
    ),
  );
}

function uniqueTokenHash(): string {
  return `test-hash-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

describe("invite_links RPCs — real Postgres", () => {
  it("accept happy path: adds the acceptor to organization_members with the invite's role and logs invite.accepted", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const acceptorId = await fixtureUserId("canvas-e2e-b@nia.dev");
    const orgId = await makeOrg(ownerId);
    const tokenHash = uniqueTokenHash();

    try {
      await createInvite(ownerId, { orgId, role: "member", tokenHash });

      const result = await acceptInvite(acceptorId, tokenHash);
      const row = result.rows[0]!;
      expect(row.org_id).toBe(orgId);
      expect(row.role).toBe("member");
      expect(row.already_member).toBe(false);

      const { rows: memberRows } = await dbPool.query<{ role: string }>(
        "select role from public.organization_members where org_id = $1 and user_id = $2",
        [orgId, acceptorId],
      );
      expect(memberRows[0]?.role).toBe("member");

      const { rows: auditRows } = await dbPool.query<{ action: string }>(
        "select action from public.audit_log where org_id = $1 and action = 'invite.accepted'",
        [orgId],
      );
      expect(auditRows).toHaveLength(1);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("already a member: accepting again does not change their role or write another audit row", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const acceptorId = await fixtureUserId("canvas-e2e-b@nia.dev");
    const orgId = await makeOrg(ownerId);
    const tokenHash = uniqueTokenHash();

    try {
      await createInvite(ownerId, { orgId, role: "admin", tokenHash });
      await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'member')", [
        orgId,
        acceptorId,
      ]);

      const result = await acceptInvite(acceptorId, tokenHash);
      const row = result.rows[0]!;
      expect(row.already_member).toBe(true);
      expect(row.role).toBe("member");

      const { rows: memberRows } = await dbPool.query<{ role: string }>(
        "select role from public.organization_members where org_id = $1 and user_id = $2",
        [orgId, acceptorId],
      );
      expect(memberRows[0]?.role).toBe("member");

      const { rows: auditRows } = await dbPool.query(
        "select 1 from public.audit_log where org_id = $1 and action = 'invite.accepted'",
        [orgId],
      );
      expect(auditRows).toHaveLength(0);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("expired invite is refused with a clear message", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const acceptorId = await fixtureUserId("canvas-e2e-c@nia.dev");
    const orgId = await makeOrg(ownerId);
    const tokenHash = uniqueTokenHash();

    try {
      await createInvite(ownerId, { orgId, tokenHash, expiresAt: new Date(Date.now() - 1000) });

      await expect(acceptInvite(acceptorId, tokenHash)).rejects.toMatchObject({
        message: expect.stringContaining("expired"),
      });
    } finally {
      await dropOrg(orgId);
    }
  });

  it("revoked invite is refused with a clear message", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const acceptorId = await fixtureUserId("canvas-e2e-c@nia.dev");
    const orgId = await makeOrg(ownerId);
    const tokenHash = uniqueTokenHash();

    try {
      const created = await createInvite(ownerId, { orgId, tokenHash });
      const inviteId = created.rows[0]!.id;

      await withActingUser(dbPool, ownerId, (db) => db.query("select public.revoke_invite($1)", [inviteId]));

      await expect(acceptInvite(acceptorId, tokenHash)).rejects.toMatchObject({
        message: expect.stringContaining("revoked"),
      });
    } finally {
      await dropOrg(orgId);
    }
  });

  it("max_uses race: two concurrent accepts against a max_uses=1 invite — exactly one succeeds", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const acceptorBId = await fixtureUserId("canvas-e2e-b@nia.dev");
    const acceptorCId = await fixtureUserId("canvas-e2e-c@nia.dev");
    const orgId = await makeOrg(ownerId);
    const tokenHash = uniqueTokenHash();

    try {
      await createInvite(ownerId, { orgId, tokenHash, maxUses: 1 });

      const results = await Promise.allSettled([
        acceptInvite(acceptorBId, tokenHash),
        acceptInvite(acceptorCId, tokenHash),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as Error).message).toContain("already been used");

      const { rows } = await dbPool.query<{ count: string }>(
        "select count(*) as count from public.organization_members where org_id = $1 and role <> 'owner'",
        [orgId],
      );
      expect(Number(rows[0]?.count)).toBe(1);
    } finally {
      await dropOrg(orgId);
    }
  });

  it("admin cannot create an owner-role invite; owner can", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const adminId = await fixtureUserId("canvas-e2e-b@nia.dev");
    const orgId = await makeOrg(ownerId);

    try {
      await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'admin')", [
        orgId,
        adminId,
      ]);

      await expect(createInvite(adminId, { orgId, role: "owner", tokenHash: uniqueTokenHash() })).rejects.toMatchObject(
        { message: expect.stringContaining("only an owner may create an owner-role invite") },
      );

      await expect(
        createInvite(ownerId, { orgId, role: "owner", tokenHash: uniqueTokenHash() }),
      ).resolves.toBeTruthy();
    } finally {
      await dropOrg(orgId);
    }
  });
});
