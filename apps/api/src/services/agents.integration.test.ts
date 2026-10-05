import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { withActingUser, withServiceRole } from "@nia/db";
import { dbPool } from "../lib/dbPool.js";
import { createPairingCode, listAgents, revokeAgent } from "./agents.js";

/**
 * docs/plans/agent-canvas-integration.md Slice 1 ("Link") — platform side.
 * Real local Postgres only (apps/api/.env's DATABASE_URL), same fixture
 * users/org helpers as invites.integration.test.ts. Run explicitly with
 * `pnpm test:integration` (apps/api/vitest.integration.config.ts).
 *
 * The bridge's own service-role writes (services/agent-bridge/src/app.ts's
 * /pair insert, /check-in's update) are simulated here directly via
 * withServiceRole against the same dbPool — apps/api's own runtime code
 * never calls withServiceRole (see lib/dbPool.ts's header), but a test
 * standing in for the bridge (which this process never spins up) needs to
 * reproduce exactly what that connection would do.
 */

afterAll(async () => {
  await dbPool.end();
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixtureUserId(email: string): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>('select id from public."user" where email = $1', [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`fixture user ${email} not found — run \`pnpm --filter @nia/api seed:fixtures\` first`);
  return id;
}

async function makeOrg(ownerId: string): Promise<string> {
  const { rows } = await dbPool.query<{ id: string }>(
    `insert into public.organizations (name, slug, created_by) values ($1, $2, $3) returning id`,
    ["agents test org", `agents-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, ownerId],
  );
  const orgId = rows[0]!.id;
  await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, 'owner')", [
    orgId,
    ownerId,
  ]);
  return orgId;
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await dbPool.query("insert into public.organization_members (org_id, user_id, role) values ($1, $2, $3)", [
    orgId,
    userId,
    role,
  ]);
}

async function dropOrg(orgId: string): Promise<void> {
  await dbPool.query(
    "alter table public.organization_members disable trigger organization_members_protect_last_super_admin",
  );
  try {
    await dbPool.query("delete from public.organizations where id = $1", [orgId]);
  } finally {
    await dbPool.query(
      "alter table public.organization_members enable trigger organization_members_protect_last_super_admin",
    );
  }
}

function withUserFor(actingUserId: string) {
  return <T>(fn: (db: import("@nia/db").Queryable) => Promise<T>) => withActingUser(dbPool, actingUserId, fn);
}

type ConsumeResult = {
  status: "ok" | "not_found" | "locked" | "used" | "expired" | "incorrect";
  org_id: string | null;
  owner_id: string | null;
  created_by_user_id: string | null;
};

// Mirrors services/agent-bridge/src/app.ts's PAIR_REFUSAL_MESSAGE — the RPC
// returns a status instead of raising (0069_platform_agents.sql's header
// comment on consume_agent_pairing_code), so the bridge (and this stand-in)
// maps it to an error message itself.
const PAIR_REFUSAL_MESSAGE: Record<Exclude<ConsumeResult["status"], "ok">, string> = {
  not_found: "pairing code not found",
  locked: "pairing code is locked",
  used: "pairing code has already been used",
  expired: "pairing code has expired",
  incorrect: "pairing code is incorrect",
};

/** Stands in for the bridge's /pair handler: consume the code, then insert the agent row — both via withServiceRole, exactly as services/agent-bridge/src/app.ts does. */
async function simulatePair(
  pairingCodeId: string,
  code: string,
): Promise<{ agentId: string; agentKey: string }> {
  const codeHash = sha256Hex(code);
  const { rows } = await withServiceRole(dbPool, (db) =>
    db.query<ConsumeResult>("select * from public.consume_agent_pairing_code($1, $2)", [pairingCodeId, codeHash]),
  );
  const result = rows[0];
  if (!result) throw new Error("pairing code is invalid");
  if (result.status !== "ok") throw new Error(PAIR_REFUSAL_MESSAGE[result.status]);

  const agentKey = "test-agent-key-" + Math.random().toString(36).slice(2, 10);
  const agentKeyHash = sha256Hex(agentKey);
  const { rows: agentRows } = await withServiceRole(dbPool, (db) =>
    db.query<{ id: string }>(
      `insert into public.platform_agents
         (org_id, owner_id, created_by_user_id, display_name, agent_key_hash, status)
       values ($1, $2, $3, $4, $5, 'active')
       returning id`,
      [result.org_id, result.owner_id, result.created_by_user_id, "test agent", agentKeyHash],
    ),
  );
  return { agentId: agentRows[0]!.id, agentKey };
}

describe("platform_agents / agent_pairing_codes — real Postgres", () => {
  it("a valid pairing code creates an active agent and returns a key once; only hashes are stored", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const orgId = await makeOrg(ownerId);

    try {
      const { pairingCodeId, code } = await createPairingCode(withUserFor(ownerId), { orgId });
      const { agentId, agentKey } = await simulatePair(pairingCodeId, code);

      const { rows } = await dbPool.query<{ agent_key_hash: string; status: string }>(
        "select agent_key_hash, status from public.platform_agents where id = $1",
        [agentId],
      );
      expect(rows[0]?.status).toBe("active");
      expect(rows[0]?.agent_key_hash).toBe(sha256Hex(agentKey));
      expect(rows[0]?.agent_key_hash).not.toBe(agentKey);

      const agents = await listAgents(withUserFor(ownerId));
      expect(agents.find((a) => a.id === agentId)?.status).toBe("active");
    } finally {
      await dropOrg(orgId);
    }
  });

  it("an expired, used, or wrong code is refused, and the fifth wrong attempt locks the code", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const orgId = await makeOrg(ownerId);

    try {
      // Wrong code is refused without consuming it.
      const wrong = await createPairingCode(withUserFor(ownerId), { orgId });
      await expect(simulatePair(wrong.pairingCodeId, "WRONGCOD")).rejects.toMatchObject({
        message: expect.stringContaining("incorrect"),
      });

      // Expired code is refused (backdated directly — create_agent_pairing_code hardcodes +15m).
      const expired = await createPairingCode(withUserFor(ownerId), { orgId });
      await dbPool.query("update public.agent_pairing_codes set expires_at = now() - interval '1 minute' where id = $1", [
        expired.pairingCodeId,
      ]);
      await expect(simulatePair(expired.pairingCodeId, expired.code)).rejects.toMatchObject({
        message: expect.stringContaining("expired"),
      });

      // Used code is refused on a second attempt.
      const used = await createPairingCode(withUserFor(ownerId), { orgId });
      await simulatePair(used.pairingCodeId, used.code);
      await expect(simulatePair(used.pairingCodeId, used.code)).rejects.toMatchObject({
        message: expect.stringContaining("already been used"),
      });

      // The first four wrong attempts are refused as "incorrect"; the fifth trips
      // max_attempts (5) and is reported as "locked" directly — and a further
      // attempt with the correct code afterward is still refused as locked.
      const lockout = await createPairingCode(withUserFor(ownerId), { orgId });
      for (let i = 0; i < 4; i++) {
        await expect(simulatePair(lockout.pairingCodeId, "WRONGCOD")).rejects.toMatchObject({
          message: expect.stringContaining("incorrect"),
        });
      }
      await expect(simulatePair(lockout.pairingCodeId, "WRONGCOD")).rejects.toMatchObject({
        message: expect.stringContaining("locked"),
      });
      await expect(simulatePair(lockout.pairingCodeId, lockout.code)).rejects.toMatchObject({
        message: expect.stringContaining("locked"),
      });
    } finally {
      await dropOrg(orgId);
    }
  });

  it("a revoked agent's key is rejected, and a member of another org cannot see or revoke the agent", async () => {
    const ownerId = await fixtureUserId("canvas-e2e-a@nia.dev");
    const otherMemberId = await fixtureUserId("canvas-e2e-b@nia.dev");
    const orgId = await makeOrg(ownerId);
    const otherOrgId = await makeOrg(await fixtureUserId("canvas-e2e-c@nia.dev"));

    try {
      await addMember(otherOrgId, otherMemberId, "member");

      const { pairingCodeId, code } = await createPairingCode(withUserFor(ownerId), { orgId });
      const { agentId, agentKey } = await simulatePair(pairingCodeId, code);

      // A member of another org cannot see the agent (RLS-scoped list).
      const otherOrgAgents = await listAgents(withUserFor(otherMemberId));
      expect(otherOrgAgents.find((a) => a.id === agentId)).toBeUndefined();

      // A member of another org cannot revoke it either (RLS filters the row out before the authorization check).
      await expect(revokeAgent(withUserFor(otherMemberId), "member", otherMemberId, agentId)).rejects.toMatchObject({
        statusCode: 404,
      });

      await revokeAgent(withUserFor(ownerId), "owner", ownerId, agentId);

      // Post-revocation, a check-in-style lookup (what the bridge's /check-in does) finds no row.
      const { rows } = await withServiceRole(dbPool, (db) =>
        db.query<{ id: string }>(
          "update public.platform_agents set last_check_in_at = now() where agent_key_hash = $1 and status <> 'revoked' returning id",
          [sha256Hex(agentKey)],
        ),
      );
      expect(rows).toHaveLength(0);
    } finally {
      await dropOrg(orgId);
      await dropOrg(otherOrgId);
    }
  });
});
