import { describe, it, expect, vi, beforeEach } from "vitest";

// Email Phase 3 — lean coverage for the public "Request access" Server
// Action: honeypot no-ops, rate-limited still "succeeds" generically,
// dedupe behavior (pending/approved no-op vs. rejected-row resubmit), and
// that a genuinely new/resubmitted row enqueues accessRequestReceived.

const query = vi.fn();
vi.mock("@nia/db", () => ({ withServiceRole: (_pool: unknown, fn: (db: { query: typeof query }) => unknown) => fn({ query }) }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({}) }));

const isAuthActionRateLimited = vi.fn();
vi.mock("@/lib/auth/rateLimit", () => ({
  isAuthActionRateLimited: (...args: unknown[]) => isAuthActionRateLimited(...args),
}));

const enqueueEmail = vi.fn();
vi.mock("@/lib/mail/mailQueue", () => ({ enqueueEmail: (...args: unknown[]) => enqueueEmail(...args) }));

const { submitAccessRequest } = await import("./actions");

function formData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      for (const item of v) fd.append(k, item);
    } else {
      fd.set(k, v);
    }
  }
  return fd;
}

const VALID_FIELDS = {
  email: "requester@example.com",
  fullName: "Req Ester",
  company: "Acme",
  useCase: "ETL into our warehouse",
  consent: "on",
};

beforeEach(() => {
  query.mockReset();
  isAuthActionRateLimited.mockReset();
  isAuthActionRateLimited.mockResolvedValue(false);
  enqueueEmail.mockReset();
});

describe("submitAccessRequest", () => {
  it("returns generic success without touching the DB or queue when the honeypot is filled", async () => {
    const result = await submitAccessRequest(null, formData({ ...VALID_FIELDS, website: "http://spam.example" }));

    expect(result).toEqual({ success: true });
    expect(query).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("rejects missing required fields with field errors, without touching the DB", async () => {
    const result = await submitAccessRequest(null, formData({ email: "not-an-email" }));

    expect(result?.fieldErrors?.email).toBeTruthy();
    expect(result?.fieldErrors?.fullName).toBeTruthy();
    expect(result?.fieldErrors?.consent).toBeTruthy();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns generic success when rate-limited, without inserting or emailing", async () => {
    isAuthActionRateLimited.mockResolvedValue(true);

    const result = await submitAccessRequest(null, formData(VALID_FIELDS));

    expect(result).toEqual({ success: true });
    expect(query).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("inserts a new row and enqueues accessRequestReceived for a genuinely new email", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "req-1" }] });

    const result = await submitAccessRequest(null, formData(VALID_FIELDS));

    expect(result).toEqual({ success: true });
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: VALID_FIELDS.email, payload: expect.objectContaining({ template: "accessRequestReceived" }) }),
    );
  });

  it("no-ops (still returns generic success, no email) when the ON CONFLICT doesn't match (existing pending/approved row)", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await submitAccessRequest(null, formData(VALID_FIELDS));

    expect(result).toEqual({ success: true });
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("resubmitting flips a previously-rejected row back to pending and re-emails", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "req-1" }] });

    await submitAccessRequest(null, formData(VALID_FIELDS));

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/on conflict \(lower\(email\)\) do update/i);
    expect(sql).toMatch(/where access_requests\.status = 'rejected'/i);
    expect(params[0]).toBe(VALID_FIELDS.email);
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
  });
});
