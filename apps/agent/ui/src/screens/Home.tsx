import { useEffect, useState } from "react";
import { getStatus, listConnections, ApiClientError, type StatusResponse, type ConnectionEntry } from "../apiClient";

type Pill = "connected" | "notConnected" | "problem";

function pillFor(status: StatusResponse): { pill: Pill; label: string } {
  if (!status.paired) return { pill: "notConnected", label: "Not connected" };
  if (status.revoked) return { pill: "problem", label: "Revoked" };
  if (!status.online) return { pill: "problem", label: "Offline" };
  return { pill: "connected", label: "Connected" };
}

export function Home() {
  const [status, setStatus] = useState<StatusResponse | undefined>(undefined);
  const [connections, setConnections] = useState<ConnectionEntry[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    Promise.all([getStatus(), listConnections()])
      .then(([status, { connections }]) => {
        setStatus(status);
        setConnections(connections);
      })
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Couldn't load status."));
  }, []);

  if (error) {
    return (
      <div className="agent-screen">
        <h1>Home</h1>
        <p className="agent-error">{error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="agent-screen">
        <h1>Home</h1>
        <p>Loading...</p>
      </div>
    );
  }

  const { pill, label } = pillFor(status);
  const jobs = Object.entries(status.jobs);

  return (
    <div className="agent-screen">
      <h1>Home</h1>
      <span className={`agent-pill agent-pill--${pill}`}>{label}</span>

      {status.paired && (
        <>
          <p>
            Platform: <span className="agent-text-muted">{status.platformUrl}</span>
          </p>
          <p>
            Last check-in: <span className="agent-text-muted">{status.lastCheckInAt ?? "never"}</span>
          </p>
        </>
      )}

      <p>
        Version: <span className="agent-text-muted">{status.agentVersion}</span>
      </p>
      {status.uptimeSeconds !== undefined && (
        <p>
          Uptime: <span className="agent-text-muted">{Math.floor(status.uptimeSeconds / 60)}m</span>
        </p>
      )}

      <h2>Connected databases</h2>
      {connections.length === 0 ? (
        <p className="agent-text-muted">None yet.</p>
      ) : (
        <ul className="agent-plain-list">
          {connections.map((c) => (
            <li key={c.id}>{c.label}</li>
          ))}
        </ul>
      )}

      <h2>Jobs</h2>
      {jobs.length === 0 ? (
        <p className="agent-text-muted">No jobs yet.</p>
      ) : (
        <ul className="agent-plain-list">
          {jobs.map(([id, job]) => (
            <li key={id}>
              {id}: <span className="agent-text-muted">{job.paused ? `paused (${job.paused.reason})` : job.lastResult ?? "never run"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
