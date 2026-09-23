import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SourceDestConfig, StepFailureReport } from "@nia/schemas";

// Lean, targeted coverage for the "nia" write-grant-scope fix (item 3 —
// see docs/decisions.md's "Staging/quarantine writes in `nia` inherit the
// destination grant for that run, and nothing wider"). writeDispatch.test.ts
// already proves dispatchWrite() enforces whatever grantNamespace it's
// given; this file proves the other half — that stagedWrite.ts's per-chunk
// and quarantine writers actually COMPUTE that grantNamespace from the
// run's real destination entity, not the physical "nia" staging/quarantine
// entity they write rows into. Without this half, the connector-side fix
// alone can't be exercised: a staged run would still fail with "No
// confirmed, unrevoked write grant covers schema 'nia'" exactly as the
// reported run did, since nothing would ever populate grantNamespace.
const dispatchWriteMock = vi.fn();
vi.mock("../writeDispatch.js", () => ({ dispatchWrite: (...args: unknown[]) => dispatchWriteMock(...args) }));

const { writeChunkRows, writeQuarantineRows } = await import("./stagedWrite.js");

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";
const RUN_ID = "44444444-4444-4444-4444-444444444444";
const SCOPE = { orgId: "org-1" };

const destEntity = { namespace: "nia", name: "users_dest" };
const stagingEntity = { namespace: "nia", name: "stg_run1_users_dest" };
const quarantineEntity = { namespace: "nia", name: "nia_quarantine" };

const destConfig: SourceDestConfig = {
  operation: "insert",
  entity: destEntity,
  upsertKeys: ["id"],
};

beforeEach(() => {
  dispatchWriteMock.mockReset();
  dispatchWriteMock.mockResolvedValue({ ok: true, value: { written: 1, durationMs: 1 } });
});

describe("stagedWrite — grantNamespace scoping (nia scope rule)", () => {
  it("writeChunkRows in staged mode authorizes against the destination's real namespace, not the physical staging entity's", async () => {
    await writeChunkRows(
      CONNECTION_ID,
      { mode: "staged", stagingEntity, quarantineEntity },
      destConfig,
      ["id", "email"],
      [[1, "a@example.com"]],
      SCOPE,
      ACTOR_ID,
      RUN_ID,
    );

    expect(dispatchWriteMock).toHaveBeenCalledTimes(1);
    const [connId, input] = dispatchWriteMock.mock.calls[0]!;
    expect(connId).toBe(CONNECTION_ID);
    // Physically writes into the staging entity...
    expect(input.entity).toEqual(stagingEntity);
    // ...but the grant checked/signed is the RUN's real destination
    // namespace ("sales", say — here destEntity.namespace), never the
    // staging/quarantine entity's own "nia" namespace.
    expect(input.grantNamespace).toBe(destEntity.namespace);
  });

  it("writeChunkRows in direct mode never sets grantNamespace (defaults to entity.namespace downstream, unchanged pre-Phase-11 behavior)", async () => {
    await writeChunkRows(
      CONNECTION_ID,
      { mode: "direct", stagingEntity: null, quarantineEntity: null },
      destConfig,
      ["id", "email"],
      [[1, "a@example.com"]],
      SCOPE,
      ACTOR_ID,
      RUN_ID,
    );

    const [, input] = dispatchWriteMock.mock.calls[0]!;
    expect(input.entity).toEqual(destEntity);
    expect(input.grantNamespace).toBeUndefined();
  });

  it("writeQuarantineRows authorizes against the destination's real namespace, not nia_quarantine's own", async () => {
    const failures: StepFailureReport[] = [
      {
        label: "step-1",
        fns: ["parse_date"],
        policy: "quarantine",
        count: 1,
        quarantinedRows: [{ fn: "parse_date", inputValue: "bad", sourceRow: { id: 1 } }],
      } as StepFailureReport,
    ];

    await writeQuarantineRows(CONNECTION_ID, { mode: "staged", stagingEntity, quarantineEntity }, RUN_ID, destEntity, failures, SCOPE, ACTOR_ID);

    expect(dispatchWriteMock).toHaveBeenCalledTimes(1);
    const [, input] = dispatchWriteMock.mock.calls[0]!;
    expect(input.entity).toEqual(quarantineEntity);
    expect(input.grantNamespace).toBe(destEntity.namespace);
  });
});
