import { describe, expect, it, vi, beforeEach } from "vitest";
import { getMailTransport, resetMailTransportCache } from "./index.js";
import { LogMailTransport } from "./transports/log.js";
import { SmtpMailTransport } from "./transports/smtp.js";
import { GraphMailTransport } from "./transports/graph.js";

beforeEach(() => {
  resetMailTransportCache();
});

describe("getMailTransport", () => {
  it("defaults to the log transport when MAIL_TRANSPORT is unset", () => {
    const transport = getMailTransport({});
    expect(transport).toBeInstanceOf(LogMailTransport);
  });

  it("selects the log transport explicitly", () => {
    const transport = getMailTransport({ MAIL_TRANSPORT: "log" });
    expect(transport).toBeInstanceOf(LogMailTransport);
  });

  it("builds an smtp transport from SMTP_* env vars", () => {
    const transport = getMailTransport({
      MAIL_TRANSPORT: "smtp",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_USER: "user",
      SMTP_PASS: "pass",
      SMTP_FROM: "noreply@example.com",
    });
    expect(transport).toBeInstanceOf(SmtpMailTransport);
  });

  it("throws if a required smtp var is missing", () => {
    expect(() => getMailTransport({ MAIL_TRANSPORT: "smtp" })).toThrow(/SMTP_HOST/);
  });

  it("builds a graph transport from MS_GRAPH_* env vars", () => {
    const transport = getMailTransport({
      MAIL_TRANSPORT: "graph",
      MS_GRAPH_TENANT_ID: "tenant",
      MS_GRAPH_CLIENT_ID: "client",
      MS_GRAPH_CLIENT_SECRET: "secret",
      MS_GRAPH_SENDER: "sender@example.com",
    });
    expect(transport).toBeInstanceOf(GraphMailTransport);
  });

  it("throws if a required graph var is missing", () => {
    expect(() => getMailTransport({ MAIL_TRANSPORT: "graph" })).toThrow(/MS_GRAPH_TENANT_ID/);
  });

  it("caches the transport across calls for the same kind", () => {
    const a = getMailTransport({ MAIL_TRANSPORT: "log" });
    const b = getMailTransport({ MAIL_TRANSPORT: "log" });
    expect(a).toBe(b);
  });
});

describe("LogMailTransport", () => {
  it("never logs the email body or any secret-shaped field", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const transport = new LogMailTransport();
    await transport.send({
      to: "user@example.com",
      subject: "Your code is 123456",
      html: "<p>secret-body-marker 123456</p>",
      text: "secret-body-marker 123456",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls[0]?.join(" ") ?? "";
    expect(logged).not.toContain("secret-body-marker");
    expect(logged).toContain("user@example.com");
    spy.mockRestore();
  });
});
