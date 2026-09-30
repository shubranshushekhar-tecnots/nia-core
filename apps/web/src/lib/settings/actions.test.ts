import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({}) }));

const requireUser = vi.fn();
const requireUserWithOrg = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireUser: () => requireUser(),
  requireUserWithOrg: () => requireUserWithOrg(),
}));

const query = vi.fn();
vi.mock("@nia/db", () => ({
  withActingUser: (_pool: unknown, _userId: string, fn: (db: unknown) => unknown) => fn({ query }),
}));

const { updateProfileName, updateOrganization } = await import("./actions");

const ORG = { id: "org-1", name: "Acme", slug: "acme", suspendedAt: null, suspendedReason: null };

function profileFormData(fullName: string) {
  const fd = new FormData();
  fd.set("fullName", fullName);
  return fd;
}

function orgFormData(name: string, slug: string) {
  const fd = new FormData();
  fd.set("name", name);
  fd.set("slug", slug);
  return fd;
}

describe("updateProfileName", () => {
  beforeEach(() => {
    query.mockReset();
    requireUser.mockReset();
  });

  it("updates the current user's name on the happy path", async () => {
    requireUser.mockResolvedValue({ userId: "user-1", email: "a@example.com", fullName: null, org: null, role: "individual", orgs: [] });
    query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await updateProfileName({}, profileFormData("  Ada Lovelace  "));

    expect(result).toEqual({ success: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("update public.profiles"), ["Ada Lovelace", "user-1"]);
  });

  it("rejects an empty name without touching the database", async () => {
    requireUser.mockResolvedValue({ userId: "user-1", email: "a@example.com", fullName: null, org: null, role: "individual", orgs: [] });

    const result = await updateProfileName({}, profileFormData("   "));

    expect(result?.fieldErrors?.fullName).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("rejects a name longer than 120 characters", async () => {
    requireUser.mockResolvedValue({ userId: "user-1", email: "a@example.com", fullName: null, org: null, role: "individual", orgs: [] });

    const result = await updateProfileName({}, profileFormData("x".repeat(121)));

    expect(result?.fieldErrors?.fullName).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("updateOrganization", () => {
  beforeEach(() => {
    query.mockReset();
    requireUserWithOrg.mockReset();
  });

  it("updates the organization's name and slug on the happy path", async () => {
    requireUserWithOrg.mockResolvedValue({ userId: "owner-1", email: "o@example.com", fullName: null, org: ORG, role: "owner" });
    query.mockResolvedValueOnce({ rowCount: 1 });

    const result = await updateOrganization({}, orgFormData("Acme Inc", "acme-inc"));

    expect(result).toEqual({ success: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("update public.organizations"), [
      "Acme Inc",
      "acme-inc",
      "org-1",
    ]);
  });

  it("rejects a malformed slug with the onboarding error message, without touching the database", async () => {
    requireUserWithOrg.mockResolvedValue({ userId: "owner-1", email: "o@example.com", fullName: null, org: ORG, role: "owner" });

    const result = await updateOrganization({}, orgFormData("Acme Inc", "Not A Slug!"));

    expect(result?.fieldErrors?.slug).toEqual(["Use lowercase letters, numbers, and hyphens only"]);
    expect(query).not.toHaveBeenCalled();
    expect(requireUserWithOrg).not.toHaveBeenCalled();
  });

  it("refuses a non-admin member's update (RLS-denied), mapped to the friendly error pattern", async () => {
    requireUserWithOrg.mockResolvedValue({ userId: "member-1", email: "m@example.com", fullName: null, org: ORG, role: "member" });

    const result = await updateOrganization({}, orgFormData("Acme Inc", "acme-inc"));

    expect(result?.error).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it("maps a unique-violation on slug to a friendly message", async () => {
    requireUserWithOrg.mockResolvedValue({ userId: "owner-1", email: "o@example.com", fullName: null, org: ORG, role: "owner" });
    query.mockRejectedValueOnce(Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }));

    const result = await updateOrganization({}, orgFormData("Acme Inc", "taken-slug"));

    expect(result).toEqual({ error: "That slug is already taken." });
  });
});
