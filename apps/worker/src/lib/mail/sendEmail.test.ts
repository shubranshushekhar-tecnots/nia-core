import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SendEmailJob } from "@nia/schemas";

const sendTemplatedMail = vi.fn();
vi.mock("@nia/mail", () => ({ sendTemplatedMail }));

describe("sendEmail", () => {
  beforeEach(() => {
    sendTemplatedMail.mockReset();
  });

  it("forwards the job's to/payload to sendTemplatedMail with the worker's env", async () => {
    const { sendEmail } = await import("./sendEmail.js");
    const job: SendEmailJob = {
      kind: "send_email",
      to: "user@example.com",
      payload: { template: "loginCode", data: { code: "123456", expiresInMinutes: 10 } },
    };

    await sendEmail(job);

    expect(sendTemplatedMail).toHaveBeenCalledTimes(1);
    const [to, payload] = sendTemplatedMail.mock.calls[0] as [string, unknown, unknown];
    expect(to).toBe("user@example.com");
    expect(payload).toEqual(job.payload);
  });

  it("rethrows on failure (so BullMQ's attempts/backoff retries it) without logging the OTP", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendTemplatedMail.mockRejectedValueOnce(new Error("smtp connect failed"));
    const { sendEmail } = await import("./sendEmail.js");
    const job: SendEmailJob = {
      kind: "send_email",
      to: "user@example.com",
      payload: { template: "loginCode", data: { code: "999999", expiresInMinutes: 10 } },
    };

    await expect(sendEmail(job)).rejects.toThrow("smtp connect failed");
    const logged = spy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(logged).not.toContain("999999");
    spy.mockRestore();
  });
});
