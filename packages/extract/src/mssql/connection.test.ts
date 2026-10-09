import { describe, expect, it } from "vitest";
import { buildPoolConfig } from "./connection.js";

const base = { server: "10.0.0.1", database: "SummitERP_1", user: "sa", password: "x" };

describe("buildPoolConfig", () => {
  it("defaults to encrypted, non-legacy TLS, no trustServerCertificate", () => {
    const config = buildPoolConfig(base);
    expect(config.options?.encrypt).toBe(true);
    expect(config.options?.trustServerCertificate).toBe(false);
    expect(config.options?.cryptoCredentialsDetails).toBeUndefined();
  });

  it("supports encrypt: false for a trusted LAN-only instance without touching TLS version", () => {
    const config = buildPoolConfig({ ...base, encrypt: false });
    expect(config.options?.encrypt).toBe(false);
    expect(config.options?.cryptoCredentialsDetails).toBeUndefined();
  });

  it("only lowers the minimum TLS version and cipher security level when allowLegacyTls is explicitly true", () => {
    const config = buildPoolConfig({ ...base, allowLegacyTls: true });
    expect(config.options?.cryptoCredentialsDetails).toEqual({ minVersion: "TLSv1", ciphers: "DEFAULT:@SECLEVEL=0" });
  });

  it("leaves legacy TLS off when allowLegacyTls is false or omitted", () => {
    expect(buildPoolConfig({ ...base, allowLegacyTls: false }).options?.cryptoCredentialsDetails).toBeUndefined();
    expect(buildPoolConfig(base).options?.cryptoCredentialsDetails).toBeUndefined();
  });

  it("models one connection per database, never a server-wide connection", () => {
    const a = buildPoolConfig({ ...base, database: "SummitERP_1" });
    const b = buildPoolConfig({ ...base, database: "SummitERP_2" });
    expect(a.database).toBe("SummitERP_1");
    expect(b.database).toBe("SummitERP_2");
  });

  it("defaults port and connection timeout", () => {
    const config = buildPoolConfig(base);
    expect(config.port).toBe(1433);
    expect(config.connectionTimeout).toBe(15_000);
  });

  it("omits port and sets options.instanceName for a named instance", () => {
    const config = buildPoolConfig({ ...base, instanceName: "SQL2008ERP", port: 1433 });
    expect(config.port).toBeUndefined();
    expect(config.options?.instanceName).toBe("SQL2008ERP");
  });

  it("leaves options.instanceName unset for a plain host/port", () => {
    expect(buildPoolConfig(base).options?.instanceName).toBeUndefined();
  });
});
