import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withActingUser, withServiceRole } from "./client.js";

/**
 * Real local Postgres only (`supabase start` — DATABASE_URL defaults to the
 * local instance's direct connection, same role migrations use). Proves the
 * properties a mock can't: RLS actually isolating two real users, auth.uid()/
 * role resolution, and connection state genuinely clearing on release.
 * Run explicitly with `pnpm test:integration`.
 *
 * Fixture setup/teardown/cross-user verification below intentionally runs
 * through a raw `pool.query()` (the base DATABASE_URL role — postgres,
 * bypasses RLS by superuser attribute), never through withActingUser/
 * withServiceRole — those two are the thing under test, not the fixture
 * plumbing.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const userA = randomUUID();
const userB = randomUUID();
const connA = randomUUID();
const connB = randomUUID();

let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

  await pool.query(
    `insert into auth.users
       (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
     values
       ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $3, crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}'),
       ('00000000-0000-0000-0000-000000000000', $2, 'authenticated', 'authenticated', $4, crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}')`,
    [userA, userB, `db-pkg-test-a-${userA}@rls-probe.test`, `db-pkg-test-b-${userB}@rls-probe.test`],
  );

  await pool.query(
    `insert into public.connections
       (id, org_id, owner_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
     values
       ($1, null, $3, 'mysql', '@db-pkg-test-a', 'db pkg test a', $3, 'vault-ref-a'),
       ($2, null, $4, 'mysql', '@db-pkg-test-b', 'db pkg test b', $4, 'vault-ref-b')`,
    [connA, connB, userA, userB],
  );
});

afterAll(async () => {
  await pool.query("delete from public.audit_log where owner_id in ($1, $2)", [userA, userB]);
  await pool.query("delete from public.connections where id in ($1, $2)", [connA, connB]);
  await pool.query("delete from auth.users where id in ($1, $2)", [userA, userB]);
  await pool.end();
});

describe("withActingUser — real Postgres", () => {
  it("sets auth.uid() to the acting user, and role/claims are cleared once the connection is released", async () => {
    // max: 1 so this test's two queries are guaranteed to hit the same
    // physical connection — proving the SECOND query (outside the wrapper)
    // sees a genuinely reset session, not just a coincidentally-different one.
    const soloPool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      const inside = await withActingUser(soloPool, userA, (db) => db.query("select auth.uid() as uid"));
      expect(inside.rows[0]?.uid).toBe(userA);

      const after = await soloPool.query(
        "select auth.uid() as uid, current_setting('role', true) as role",
      );
      expect(after.rows[0]?.uid).toBeNull();
      expect(after.rows[0]?.role).not.toBe("authenticated");
    } finally {
      await soloPool.end();
    }
  });

  it("a query as user A cannot read user B's rows — real RLS", async () => {
    const asA = await withActingUser(pool, userA, (db) => db.query("select id from connections"));
    expect(asA.rows.map((r) => r.id)).toEqual([connA]);

    const asB = await withActingUser(pool, userB, (db) => db.query("select id from connections"));
    expect(asB.rows.map((r) => r.id)).toEqual([connB]);
  });

  it("a failed transaction rolls back", async () => {
    const newId = randomUUID();
    await expect(
      withActingUser(pool, userA, async (db) => {
        await db.query(
          `insert into public.connections
             (id, org_id, owner_id, connector_id, handle, display_name, owner_user_id, vault_secret_ref)
           values ($1, null, $2, 'mysql', '@db-pkg-test-rollback', 'rollback test', $2, 'vault-ref-rollback')`,
          [newId, userA],
        );
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const { rows } = await pool.query("select id from public.connections where id = $1", [newId]);
    expect(rows).toHaveLength(0);
  });

  it("a connection is returned to the pool on error (no leak/exhaustion)", async () => {
    const soloPool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      for (let i = 0; i < 5; i++) {
        await expect(
          withActingUser(soloPool, userA, async () => {
            throw new Error(`iteration ${i}`);
          }),
        ).rejects.toThrow(`iteration ${i}`);
      }
      // If the connection weren't released each time, this 6th call would
      // hang waiting for a free connection on a max:1 pool.
      const { rows } = await withActingUser(soloPool, userA, (db) => db.query("select 1 as ok"));
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await soloPool.end();
    }
  });
});

describe("log_execution_audit / log_connection_audit — role branching", () => {
  it("attributes to auth.uid() for an acting-user caller, and rejects service_role without an explicit actor", async () => {
    await withActingUser(pool, userA, (db) =>
      db.query(
        `select public.log_execution_audit($1, $2, 'mysql', '@db-pkg-test-a', 'select', 'select 1')`,
        [connA, userA],
      ),
    );
    const asUser = await withActingUser(pool, userA, (db) =>
      db.query(
        "select actor, owner_id, org_id from public.audit_log where owner_id = $1 and action = 'connection.execute' order by created_at desc limit 1",
        [userA],
      ),
    );
    expect(asUser.rows[0]).toMatchObject({ actor: userA, owner_id: userA, org_id: null });

    await expect(
      withServiceRole(pool, (db) =>
        db.query(
          `select public.log_execution_audit($1, $2, 'mysql', '@db-pkg-test-a', 'select', 'select 1')`,
          [connA, userA],
        ),
      ),
    ).rejects.toThrow(/p_actor_user_id is required for service_role callers/);
  });

  it("attributes to the explicit p_actor_user_id for a service_role caller", async () => {
    await withServiceRole(pool, (db) =>
      db.query(
        `select public.log_execution_audit($1, $2, 'mysql', '@db-pkg-test-a', 'worker-op', 'select 1', $2)`,
        [connA, userA],
      ),
    );
    const { rows } = await pool.query(
      "select actor, owner_id, org_id, detail from public.audit_log where owner_id = $1 and action = 'connection.execute' order by created_at desc limit 1",
      [userA],
    );
    expect(rows[0]).toMatchObject({ actor: userA, owner_id: userA, org_id: null });
    expect(rows[0]?.detail?.operation).toBe("worker-op");
  });

  it("log_connection_audit branches the same way for both caller types", async () => {
    await withActingUser(pool, userA, (db) =>
      db.query(`select public.log_connection_audit($1, 'updated', '{}'::jsonb)`, [connA]),
    );
    const asUser = await pool.query(
      "select actor from public.audit_log where owner_id = $1 and action = 'updated' order by created_at desc limit 1",
      [userA],
    );
    expect(asUser.rows[0]?.actor).toBe(userA);

    await expect(
      withServiceRole(pool, (db) => db.query(`select public.log_connection_audit($1, 'updated', '{}'::jsonb)`, [connA])),
    ).rejects.toThrow(/p_actor_user_id is required for service_role callers/);

    await withServiceRole(pool, (db) =>
      db.query(`select public.log_connection_audit($1, 'updated-by-worker', '{}'::jsonb, $2)`, [connA, userA]),
    );
    const asService = await pool.query(
      "select actor from public.audit_log where owner_id = $1 and action = 'updated-by-worker' order by created_at desc limit 1",
      [userA],
    );
    expect(asService.rows[0]?.actor).toBe(userA);
  });
});
