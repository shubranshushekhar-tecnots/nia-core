import { describe, expect, it } from "vitest";
import { classifySqlLoginError } from "./sqlLoginTest.js";

function errWithCode(code: string, message = code): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("classifySqlLoginError", () => {
  it("classifies Windows-auth-only servers (error 18452) distinctly from a wrong password", () => {
    const err = new Error("Login failed for user 'sa'. The user is not associated with a trusted SQL Server connection.");
    expect(classifySqlLoginError(err)).toEqual({
      kind: "windowsAuthOnly",
      reason: "password logins are switched off on this server (it only accepts Windows sign-in)",
    });
  });

  it("classifies ELOGIN as wrong credentials", () => {
    expect(classifySqlLoginError(errWithCode("ELOGIN", "Login failed for user 'sa'."))).toEqual({
      kind: "wrongCredentials",
      reason: "wrong username or password",
    });
  });

  it("classifies 'cannot open database' as databaseNotFound, not a login failure", () => {
    const err = new Error('Cannot open database "DoesNotExist" requested by the login. The login failed.');
    expect(classifySqlLoginError(err).kind).toBe("databaseNotFound");
  });

  it("classifies a TLS protocol mismatch (legacy server) distinctly from an untrusted certificate", () => {
    expect(classifySqlLoginError(new Error("140736... wrong version number")).kind).toBe("tlsProtocolTooOld");
    expect(classifySqlLoginError(errWithCode("EPROTO", "write EPROTO ...")).kind).toBe("tlsProtocolTooOld");
  });

  it("classifies a certificate/handshake error as tlsCertUntrusted", () => {
    expect(classifySqlLoginError(new Error("self signed certificate")).kind).toBe("tlsCertUntrusted");
    expect(classifySqlLoginError(new Error("unable to verify the first certificate")).kind).toBe("tlsCertUntrusted");
  });

  it("classifies a refused connection as wrongPortOrInstance", () => {
    expect(classifySqlLoginError(errWithCode("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:1433")).kind).toBe("wrongPortOrInstance");
  });

  it("classifies DNS/timeout failures as unreachable", () => {
    expect(classifySqlLoginError(errWithCode("ESOCKET", "getaddrinfo ENOTFOUND tallyserver")).kind).toBe("unreachable");
    expect(classifySqlLoginError(errWithCode("ETIMEOUT", "Failed to connect ... Timed out")).kind).toBe("unreachable");
  });

  it("falls back to the raw message for anything unrecognized", () => {
    expect(classifySqlLoginError(new Error("something else entirely"))).toEqual({
      kind: "unknown",
      reason: "something else entirely",
    });
  });
});
