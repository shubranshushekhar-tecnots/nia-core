import { describe, expect, it } from "vitest";
import { parseWindowsSqlInstancesFromRegistry } from "./sqlDiscovery.js";

/** Shaped like real `reg query "HKLM\...\Microsoft SQL Server" /s` output for a default instance (dynamic port) plus a named instance (static port). */
const TWO_INSTANCE_DUMP = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL
    MSSQLSERVER    REG_SZ    MSSQL15.MSSQLSERVER
    SQLEXPRESS    REG_SZ    MSSQL15.SQLEXPRESS

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.MSSQLSERVER\\MSSQLServer\\SuperSocketNetLib\\Tcp
    Enabled    REG_DWORD    0x1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.MSSQLSERVER\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll
    TcpDynamicPorts    REG_SZ    49172
    TcpPort    REG_SZ

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp
    Enabled    REG_DWORD    0x1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll
    TcpDynamicPorts    REG_SZ
    TcpPort    REG_SZ    1433
`;

/**
 * SQL Server Express ships with TCP/IP disabled out of the box, but its
 * `IPAll\TcpDynamicPorts` is still left as the literal string "0" (a
 * placeholder meaning "assign dynamically once enabled", not an actual
 * bound port 0) — `Tcp\Enabled` is the only reliable on/off switch.
 */
const TCP_DISABLED_WITH_STALE_DYNAMIC_ZERO_DUMP = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL
    NIAEXPRESS    REG_SZ    MSSQL16.NIAEXPRESS

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL16.NIAEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp
    Enabled    REG_DWORD    0x0

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL16.NIAEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll
    TcpDynamicPorts    REG_SZ    0
    TcpPort    REG_SZ
`;

/** Same shape as a real instance switched to Windows Authentication only (`LoginMode` DWORD 1), e.g. by the CI harness's `Set-SqlLoginMode`. */
const WINDOWS_ONLY_AUTH_DUMP = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL
    SQLEXPRESS    REG_SZ    MSSQL15.SQLEXPRESS

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer
    LoginMode    REG_DWORD    0x1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp
    Enabled    REG_DWORD    0x1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll
    TcpDynamicPorts    REG_SZ
    TcpPort    REG_SZ    1433
`;

/** Mixed Mode (`LoginMode` DWORD 2) — the normal, SQL-login-accepting state. */
const MIXED_MODE_AUTH_DUMP = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL
    SQLEXPRESS    REG_SZ    MSSQL15.SQLEXPRESS

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer
    LoginMode    REG_DWORD    0x2

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp
    Enabled    REG_DWORD    0x1

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.SQLEXPRESS\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll
    TcpDynamicPorts    REG_SZ
    TcpPort    REG_SZ    1433
`;

describe("parseWindowsSqlInstancesFromRegistry", () => {
  it("parses two instances into the right names and ports", () => {
    const instances = parseWindowsSqlInstancesFromRegistry(TWO_INSTANCE_DUMP);

    expect(instances).toEqual([
      { name: "MSSQLSERVER", instanceId: "MSSQL15.MSSQLSERVER", port: 49172, tcpEnabled: true },
      { name: "SQLEXPRESS", instanceId: "MSSQL15.SQLEXPRESS", port: 1433, tcpEnabled: true },
    ]);
  });

  it("treats a disabled Tcp protocol as disabled even with a stale TcpDynamicPorts=0", () => {
    const instances = parseWindowsSqlInstancesFromRegistry(TCP_DISABLED_WITH_STALE_DYNAMIC_ZERO_DUMP);

    expect(instances).toEqual([{ name: "NIAEXPRESS", instanceId: "MSSQL16.NIAEXPRESS", tcpEnabled: false }]);
  });

  it("reads LoginMode 1 (Windows Authentication only) from the instance's own MSSQLServer key", () => {
    const instances = parseWindowsSqlInstancesFromRegistry(WINDOWS_ONLY_AUTH_DUMP);

    expect(instances).toEqual([
      { name: "SQLEXPRESS", instanceId: "MSSQL15.SQLEXPRESS", port: 1433, tcpEnabled: true, loginMode: 1 },
    ]);
  });

  it("reads LoginMode 2 (Mixed Mode) the same way", () => {
    const instances = parseWindowsSqlInstancesFromRegistry(MIXED_MODE_AUTH_DUMP);

    expect(instances).toEqual([
      { name: "SQLEXPRESS", instanceId: "MSSQL15.SQLEXPRESS", port: 1433, tcpEnabled: true, loginMode: 2 },
    ]);
  });
});
