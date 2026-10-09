import { useEffect, useState } from "react";
import { listWorkflows, ApiClientError, type WorkflowSummary, type LocalWorkflowStatus } from "../apiClient";

type Pill = "connected" | "notConnected" | "problem";

function pillFor(status: LocalWorkflowStatus): { pill: Pill; label: string } {
  switch (status) {
    case "running":
      return { pill: "connected", label: "Running" };
    case "ok":
      return { pill: "connected", label: "Idle" };
    case "paused":
      return { pill: "notConnected", label: "Paused" };
    case "waiting":
      return { pill: "notConnected", label: "Waiting" };
    case "failing":
      return { pill: "problem", label: "Failing" };
    case "rejected":
      return { pill: "problem", label: "Rejected" };
  }
}

interface WorkflowsProps {
  onOpen: (workflowId: string) => void;
}

/** List of this agent's platform-published workflows -- read-only, see WorkflowDetail for actions. */
export function Workflows({ onOpen }: WorkflowsProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    listWorkflows()
      .then(({ workflows, offline }) => {
        setWorkflows(workflows);
        setOffline(offline);
      })
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Couldn't load workflows."));
  }, []);

  if (error) {
    return (
      <div className="agent-screen">
        <h1>Workflows</h1>
        <p className="agent-error">{error}</p>
      </div>
    );
  }

  if (!workflows) {
    return (
      <div className="agent-screen">
        <h1>Workflows</h1>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="agent-screen">
      <h1>Workflows</h1>
      {offline && <p className="agent-text-muted">Offline -- showing last known data.</p>}

      {workflows.length === 0 ? (
        <p className="agent-text-muted">No workflows published to this agent yet.</p>
      ) : (
        <ul className="agent-plain-list">
          {workflows.map((w) => {
            const { pill, label } = pillFor(w.status);
            return (
              <li key={w.workflowId}>
                <button className="agent-list-item" onClick={() => onOpen(w.workflowId)}>
                  <div className="agent-button-row">
                    <strong>{w.name}</strong>
                    <span className={`agent-pill agent-pill--${pill}`}>{label}</span>
                  </div>
                  {w.status === "rejected" && w.rejectionReason && <div className="agent-error">{w.rejectionReason}</div>}
                  {w.status === "failing" && w.errorClass && <div className="agent-error">{w.errorClass}</div>}
                  {w.lastRun && (
                    <div className="agent-text-muted">
                      Last run: {w.lastRun.status} at {w.lastRun.finishedAt} ({w.lastRun.rowsSent} rows)
                    </div>
                  )}
                  {w.nextRunAt && <div className="agent-text-muted">Next run: {w.nextRunAt}</div>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
