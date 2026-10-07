import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsSqlInstance {
  name: string;
  instanceId: string;
  /** Static or dynamic TCP port actually in use, or undefined if TCP/IP is disabled for this instance. */
  port?: number;
  tcpEnabled: boolean;
}

const REGISTRY_ROOT = "HKLM\\SOFTWARE\\Microsoft\\Microsoft SQL Server";

/**
 * `nia-agent setup`'s database step, Windows + localhost only: lists every
 * installed SQL Server instance and the TCP port it's actually listening
 * on, read from the same registry location SQL Server Configuration
 * Manager itself reads. Never throws — returns [] off Windows, or if `reg
 * query` fails (e.g. no SQL Server installed), so the wizard just falls
 * back to asking for host/port directly.
 */
export async function detectWindowsSqlInstances(): Promise<WindowsSqlInstance[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("reg", ["query", REGISTRY_ROOT, "/s"]);
    return parseWindowsSqlInstancesFromRegistry(stdout);
  } catch {
    return [];
  }
}

/**
 * Exported for unit testing without a Windows host. `dump` is `reg query
 * "HKLM\...\Microsoft SQL Server" /s` output: one `HKEY_LOCAL_MACHINE...`
 * block per key, each followed by its indented `name    REG_TYPE    value`
 * lines. The `Instance Names\SQL` block maps each instance's display name
 * to its instance id (e.g. "SQLEXPRESS" -> "MSSQL15.SQLEXPRESS"); that
 * instance id's own `...\MSSQLServer\SuperSocketNetLib\Tcp` block's
 * `Enabled` DWORD is the actual protocol on/off switch — its `IPAll`
 * sub-block's `TcpPort`/`TcpDynamicPorts` only carry the port once TCP/IP
 * is enabled. A missing `Tcp` block, an `Enabled` value other than `0x1`,
 * or a missing `IPAll` block all mean TCP/IP is disabled for that
 * instance. Note SQL Server Express ships with TCP/IP disabled out of the
 * box but still leaves `IPAll\TcpDynamicPorts` set to the literal string
 * "0" (its placeholder for "assign dynamically once enabled") — that must
 * not be read as a real port 0, so `Enabled` is checked first and wins.
 */
export function parseWindowsSqlInstancesFromRegistry(dump: string): WindowsSqlInstance[] {
  const blocks = splitIntoBlocks(dump);

  const namesBlock = blocks.find((b) => /\\Instance Names\\SQL$/i.test(b.key));
  if (!namesBlock) return [];

  const instances: WindowsSqlInstance[] = [];
  for (const { name, value: instanceId } of namesBlock.values) {
    const tcpBlock = blocks.find((b) =>
      new RegExp(`\\\\${escapeRegExp(instanceId)}\\\\MSSQLServer\\\\SuperSocketNetLib\\\\Tcp$`, "i").test(b.key),
    );
    const enabledValue = tcpBlock ? findValue(tcpBlock.values, "Enabled") : undefined;
    const protocolEnabled = enabledValue !== undefined && /^0x0*1$/i.test(enabledValue.trim());

    const ipAllBlock = blocks.find((b) =>
      new RegExp(`\\\\${escapeRegExp(instanceId)}\\\\MSSQLServer\\\\SuperSocketNetLib\\\\Tcp\\\\IPAll$`, "i").test(b.key),
    );
    if (!protocolEnabled || !ipAllBlock) {
      instances.push({ name, instanceId, tcpEnabled: false });
      continue;
    }
    const tcpPort = findValue(ipAllBlock.values, "TcpPort");
    const tcpDynamicPorts = findValue(ipAllBlock.values, "TcpDynamicPorts");
    const port = firstNonEmptyPort(tcpPort, tcpDynamicPorts);
    instances.push({ name, instanceId, port, tcpEnabled: port !== undefined });
  }
  return instances;
}

interface RegistryBlock {
  key: string;
  values: { name: string; value: string }[];
}

function splitIntoBlocks(dump: string): RegistryBlock[] {
  const blocks: RegistryBlock[] = [];
  let current: RegistryBlock | undefined;
  for (const line of dump.split(/\r?\n/)) {
    if (/^HKEY_LOCAL_MACHINE/i.test(line.trim())) {
      current = { key: line.trim(), values: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const match = line.match(/^\s+(\S+)\s+(REG_\S+)\s*(.*)$/);
    if (match) current.values.push({ name: match[1]!, value: match[3]!.trim() });
  }
  return blocks;
}

function findValue(values: { name: string; value: string }[], name: string): string | undefined {
  return values.find((v) => v.name === name)?.value;
}

/** A static `TcpPort` wins over `TcpDynamicPorts` when both are set — same precedence SQL Server itself uses. */
function firstNonEmptyPort(...values: (string | undefined)[]): number | undefined {
  for (const v of values) {
    if (v && /^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
