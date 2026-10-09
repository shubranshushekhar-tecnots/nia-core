import { useEffect, useState } from "react";
import { listDestinations, addDestination, removeDestination, getDiagnostics, ApiClientError } from "../apiClient";

export function Settings() {
  const [hosts, setHosts] = useState<string[]>([]);
  const [newHost, setNewHost] = useState("");
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  function reload() {
    listDestinations()
      .then(({ hosts }) => setHosts(hosts))
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Couldn't load destinations."));
  }

  useEffect(() => {
    reload();
    getDiagnostics()
      .then((d) => setVersion(d.agentVersion))
      .catch(() => setVersion(undefined));
  }, []);

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
    </div>
  );
}
