import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Lean coverage for the public "Talk to us" API route: validation,
// rate-limited still returns generic success without enqueueing, and a
// valid submission enqueues contactForm with Reply-To set to the submitter.

const isAuthActionRateLimited = vi.fn();
vi.mock("@/lib/auth/rateLimit", () => ({
  isAuthActionRateLimited: (...args: unknown[]) => isAuthActionRateLimited(...args),
}));

const enqueueEmail = vi.fn();
vi.mock("@/lib/mail/mailQueue", () => ({ enqueueEmail: (...args: unknown[]) => enqueueEmail(...args) }));

const { POST } = await import("./route");

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  topic: "question",
  name: "Req Ester",
  email: "requester@example.com",
  message: "What are you trying to move, and where to?",
};

beforeEach(() => {
  isAuthActionRateLimited.mockReset();
  isAuthActionRateLimited.mockResolvedValue(false);
  enqueueEmail.mockReset();
  delete process.env.CONTACT_TO_EMAIL;
});

describe("POST /api/contact", () => {
  it("rejects an invalid topic", async () => {
    const res = await POST(postRequest({ ...VALID_BODY, topic: "nope" }));
    expect(res.status).toBe(400);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("rejects an invalid email", async () => {
    const res = await POST(postRequest({ ...VALID_BODY, email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("rejects an empty message", async () => {
    const res = await POST(postRequest({ ...VALID_BODY, message: "   " }));
    expect(res.status).toBe(400);
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("returns generic success when rate-limited, without enqueueing", async () => {
    isAuthActionRateLimited.mockResolvedValue(true);

    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it("enqueues contactForm to the default CONTACT_TO_EMAIL with Reply-To set to the submitter", async () => {
    const res = await POST(postRequest(VALID_BODY));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "support@tecnots.com",
        replyTo: VALID_BODY.email,
        payload: expect.objectContaining({
          template: "contactForm",
          data: expect.objectContaining({ topic: VALID_BODY.topic, email: VALID_BODY.email }),
        }),
      }),
    );
  });

  it("enqueues to CONTACT_TO_EMAIL when set", async () => {
    process.env.CONTACT_TO_EMAIL = "sales@example.com";

    await POST(postRequest(VALID_BODY));

    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "sales@example.com" }));
  });
});
