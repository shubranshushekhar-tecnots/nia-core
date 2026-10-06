import { describe, expect, it } from "vitest";
import { parseWindowsSqlInstancesFromRegistry } from "./windowsSqlInstances.js";

/** Shaped like real `reg query "HKLM\...\Microsoft SQL Server" /s` output for a default instance (dynamic port) plus a named instance (static port). */
const TWO_INSTANCE_DUMP = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL
    MSSQLSERVER    REG_SZ    MSSQL15.MSSQLSERVER
    SQLEXPRESS    REG_SZ    MSSQL15.SQLEXPRESS

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\MSSQL15.MSSQLSERVER\\MSSQLServer\\SuperSocketNetLib\\Tcp\\IPAll
    TcpDynamicPorts    REG_SZ    49172
    TcpPort    REG_SZ

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
});
