import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ServiceEnsureResult {
  /** Whether a managed service (Windows service / systemd unit / launchd job) is running after this call. False, not an error, when there is no installed service at all — e.g. running `nia-agent setup` straight from an unpacked zip before `install.ps1`/`install.sh`. */
  running: boolean;
  detail: string;
}

/**
 * `nia-agent setup`'s finish step: makes sure the installed service is
 * actually running (starting it if stopped, restarting it if it's in some
 * other state) before telling the user to go check their Agents page.
 * Never throws — a missing service, or one this account can't control, is
 * reported back as `{ running: false, detail }` rather than failing the
 * whole wizard, since `nia-agent setup` is also valid to run with no
 * service installed at all (e.g. testing from source).
 */
export async function ensureServiceRunning(): Promise<ServiceEnsureResult> {
  if (process.platform === "win32") return ensureWindowsServiceRunning();
  if (process.platform === "darwin") return ensureLaunchdServiceRunning();
  return ensureSystemdServiceRunning();
}

async function ensureWindowsServiceRunning(): Promise<ServiceEnsureResult> {
  try {
    const { stdout } = await execFileAsync("sc", ["query", "nia-agent"]);
    if (/RUNNING/.test(stdout)) return { running: true, detail: "nia-agent service is running" };
    await execFileAsync("net", ["start", "nia-agent"]);
    return { running: true, detail: "started the nia-agent service" };
  } catch (err) {
    return { running: false, detail: describeServiceError(err, "no nia-agent Windows service is installed yet") };
  }
}

async function ensureSystemdServiceRunning(): Promise<ServiceEnsureResult> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["is-active", "nia-agent"]);
    if (stdout.trim() === "active") return { running: true, detail: "nia-agent service is running" };
    await execFileAsync("sudo", ["systemctl", "restart", "nia-agent"]);
    return { running: true, detail: "started the nia-agent service" };
  } catch (err) {
    return { running: false, detail: describeServiceError(err, "no nia-agent systemd service is installed yet") };
  }
}

async function ensureLaunchdServiceRunning(): Promise<ServiceEnsureResult> {
  try {
    await execFileAsync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/com.nia.agent`]);
    return { running: true, detail: "restarted the nia-agent launchd service" };
  } catch (err) {
    return { running: false, detail: describeServiceError(err, "no nia-agent launchd service is installed yet") };
  }
}

function describeServiceError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|cannot find|no such|not recognized/i.test(message) ? fallback : message;
}
