import { useEffect, useState } from "react";
import {
  listDestinations,
  addDestination,
  removeDestination,
  getDiagnostics,
  getStatus,
  getAutoUpdateSettings,
  setAutoUpdateSettings,
  checkForUpdateNow,
  ApiClientError,
  type PendingUpdate,
} from "../apiClient";

export function Settings() {
  const [hosts, setHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState("");
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState<boolean | undefined>(undefined);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | undefined>(undefined);
  const [checkingNow, setCheckingNow] = useState(false);
  const [checkNowMessage, setCheckNowMessage] = useState<string | undefined>(undefined);

  function reload() {
    listDestinations()
      .then(({ hosts }) => setHosts(hosts))
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Couldn't load destinations."));
  }

  function reloadPendingUpdate() {
    getStatus()
      .then((s) => setPendingUpdate(s.pendingUpdate))
      .catch(() => setPendingUpdate(undefined));
  }

  useEffect(() => {
    reload();
    reloadPendingUpdate();
    getDiagnostics()
      .then((d) => setVersion(d.agentVersion))
      .catch(() => setVersion(undefined));
    getAutoUpdateSettings()
      .then((s) => setAutoUpdateEnabledState(s.enabled))
      .catch(() => setAutoUpdateEnabledState(undefined));
  }, []);

  async function handleToggleAutoUpdate() {
    if (autoUpdateEnabled === undefined) return;
    const next = !autoUpdateEnabled;
    setAutoUpdateEnabledState(next); // optimistic
    try {
      const result = await setAutoUpdateSettings(next);
      setAutoUpdateEnabledState(result.enabled);
    } catch (err) {
      setAutoUpdateEnabledState(!next); // revert
      setError(err instanceof ApiClientError ? err.message : "Couldn't update that setting.");
    }
  }

  async function handleCheckNow() {
    setCheckingNow(true);
    setCheckNowMessage(undefined);
    try {
      const result = await checkForUpdateNow();
      setCheckNowMessage(result.triggered ? "Checked for updates." : "Can't check for updates right now (not paired).");
      reloadPendingUpdate();
    } catch (err) {
      setCheckNowMessage(err instanceof ApiClientError ? err.message : "Couldn't check for updates.");
    } finally {
      setCheckingNow(false);
    }
  }

  async function handleAdd() {
    if (!newHost.trim()) return;
    try {
      await addDestination(newHost.trim());
      setNewHost("");
      reload();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't add that host.");
    }
  }

  async function handleRemove(host: string) {
    try {
      await removeDestination(host);
      reload();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Couldn't remove that host.");
    }
  }

  return (
    <div className="agent-screen agent-screen--narrow">
      <h1>Settings</h1>

      <h2>Allowed destinations</h2>
      {error && <p className="agent-error">{error}</p>}
      <ul className="agent-plain-list">
        {hosts.map((host) => (
          <li key={host}>
            {host} <button className="agent-button agent-button--small" onClick={() => handleRemove(host)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="agent-button-row">
        <input className="agent-input agent-input--inline" placeholder="host.example.com" value={newHost} onChange={(e) => setNewHost(e.target.value)} />
        <button className="agent-button agent-button--primary" onClick={handleAdd} disabled={!newHost.trim()}>
          Add
        </button>
      </div>

      <h2>Version</h2>
      <p className="agent-text-muted">{version ?? "..."}</p>

      <h2>Updates</h2>
      <div className="agent-button-row">
        <label>
          <input type="checkbox" checked={autoUpdateEnabled ?? false} disabled={autoUpdateEnabled === undefined} onChange={handleToggleAutoUpdate} />
          {" "}Automatic updates
        </label>
        <button className="agent-button agent-button--small" onClick={handleCheckNow} disabled={checkingNow}>
          {checkingNow ? "Checking..." : "Check now"}
        </button>
      </div>
      {checkNowMessage && <p className="agent-text-muted">{checkNowMessage}</p>}
      {pendingUpdate && (
        <p className="agent-text-muted">
          {pendingUpdate.readyToInstall
            ? `Update ${pendingUpdate.version} is ready to install.`
            : `Update ${pendingUpdate.version} is available.`}
        </p>
      )}
    </div>
  );
}
