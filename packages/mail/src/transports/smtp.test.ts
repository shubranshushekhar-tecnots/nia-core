import { describe, expect, it, vi } from "vitest";

const sendMail = vi.fn(async () => ({ messageId: "test" }));
const createTransport = vi.fn(() => ({ sendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

describe("SmtpMailTransport", () => {
  it("builds the transport from config and forwards the message to nodemailer", async () => {
    const { SmtpMailTransport } = await import("./smtp.js");
    const transport = new SmtpMailTransport({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "user",
      pass: "pass",
      from: "Nia Core <noreply@example.com>",
    });

    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "user", pass: "pass" },
    });

    await transport.send({
      to: "person@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      attachments: [
        { filename: "logo.png", content: Buffer.from("x"), cid: "logo", contentType: "image/png" },
      ],
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: "Nia Core <noreply@example.com>",
      to: "person@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      attachments: [
        { filename: "logo.png", content: Buffer.from("x"), cid: "logo", contentType: "image/png" },
      ],
    });
  });
});
