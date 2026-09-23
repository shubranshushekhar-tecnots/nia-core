import { describe, expect, it } from "vitest";
import { friendlyConnectionError } from "./connectionErrorMessages.js";

describe("friendlyConnectionError", () => {
  const cases: { raw: string; summaryContains: string }[] = [
    { raw: "self signed certificate in certificate chain", summaryContains: "Certificate error" },
    { raw: "unable to verify the first certificate", summaryContains: "Certificate error" },
    { raw: "write EPROTO ... SSL routines ... tls alert bad record mac", summaryContains: "TLS handshake failed" },
    { raw: "getaddrinfo ENOTFOUND db.typo.example.com", summaryContains: "Host not found" },
    { raw: "getaddrinfo EAI_AGAIN db.example.com", summaryContains: "Host not found" },
    { raw: "connect ETIMEDOUT 10.0.0.5:5432", summaryContains: "Connection timed out or was refused" },
    { raw: "connect ECONNREFUSED 127.0.0.1:3306", summaryContains: "Connection timed out or was refused" },
    { raw: 'password authentication failed for user "nia_ro"', summaryContains: "Authentication failed" },
    { raw: "Access denied for user 'nia_ro'@'%' (using password: YES)", summaryContains: "Authentication failed" },
    { raw: 'permission denied for table "customers"', summaryContains: "Missing privileges" },
    { raw: "insufficient privilege", summaryContains: "Missing privileges" },
    { raw: "some completely unrecognized driver error", summaryContains: "Connection failed" },
  ];

  it.each(cases)("maps %j to the right summary category", ({ raw, summaryContains }) => {
    const result = friendlyConnectionError(raw);
    expect(result.summary).toContain(summaryContains);
  });

  it("always preserves the original raw message in details", () => {
    for (const { raw } of cases) {
      expect(friendlyConnectionError(raw).details).toBe(raw);
    }
  });
});
