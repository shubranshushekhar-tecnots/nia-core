import { useEffect, useState } from "react";
import { ReadOnlyCanvas, type ReadOnlyCanvasNode, type ReadOnlyCanvasEdge } from "@nia/canvas-view";
import {
  getWorkflow,
  getWorkflowGraph,
  listWorkflowRuns,
  postWorkflowAction,
  ApiClientError,
  type WorkflowSummary,
  type WorkflowRun,
  type SanitizedGraphNode,
  type SanitizedGraphEdge,
} from "../apiClient";

interface WorkflowDetailProps {
  workflowId: string;
  onBack: () => void;
}

function toCanvasNodes(nodes: SanitizedGraphNode[]): ReadOnlyCanvasNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: {
      graphNodeType: n.type,
      manifestName: n.manifestName ?? undefined,
      connectionLabel: n.connectionLabel ?? undefined,
      region: n.region ?? undefined,
      entityLabel: n.entityLabel ?? undefined,
      writeModeLabel: n.writeModeLabel ?? undefined,
      resolved: n.resolved,
      unknownReason: n.unknownReason ?? undefined,
    },
  }));
}

function toCanvasEdges(edges: SanitizedGraphEdge[]): ReadOnlyCanvasEdge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
  }));
}

function statusBanner(workflow: WorkflowSummary): string {
  switch (workflow.status) {
    case "running":
      return "Running";
    case "ok":
      return "Idle";
    case "paused":
      return "Paused";
    case "waiting":
      return "Waiting -- not yet applied";
    case "failing":
      return `Failing${workflow.errorClass ? ` -- ${workflow.errorClass}` : ""}`;
    case "rejected":
      return `Rejected${workflow.rejectionReason ? ` -- ${workflow.rejectionReason}` : ""}`;
  }
}

/**
 * Read-only canvas + run history + run now/pause/resume for one of this
 * agent's platform-published workflows. Per-node status is limited to
 * ready/disabled (resolved or not) -- no live check-run data reaches the
 * agent app, see the plan's "Known limitation". Actual run state is shown
 * once, above the canvas, from the list/detail endpoint's status field.
 */
export function WorkflowDetail({ workflowId, onBack }: WorkflowDetailProps) {
  const [workflow, setWorkflow] = useState<WorkflowSummary | undefined>(undefined);
  const [platformUrl, setPlatformUrl] = useState<string | undefined>(undefined);
  const [nodes, setNodes] = useState<ReadOnlyCanvasNode[]>([]);
  const [edges, setEdges] = useState<ReadOnlyCanvasEdge[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [actionPending, setActionPending] = useState(false);

  function load() {
    Promise.all([getWorkflow(workflowId), getWorkflowGraph(workflowId), listWorkflowRuns(workflowId)])
      .then(([detail, graphRes, runsRes]) => {
        setWorkflow(detail.workflow);
        setPlatformUrl(detail.platformUrl);
        setNodes(toCanvasNodes(graphRes.graph.nodes));
        setEdges(toCanvasEdges(graphRes.graph.edges));
        setRuns(runsRes.runs);
        setOffline(detail.offline || graphRes.offline || runsRes.offline);
      })
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "Couldn't load this workflow."));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [workflowId]);

  async function runAction(kind: "run_now" | "pause" | "resume") {
    setActionError(undefined);
    setActionPending(true);
    try {
      await postWorkflowAction(workflowId, { kind });
      load();
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === "massDeleteGuard") {
        setActionError("Paused by the mass-delete guard -- review and resume from the website.");
      } else {
        setActionError(err instanceof ApiClientError ? err.message : "That action failed.");
      }
    } finally {
      setActionPending(false);
    }
  }

  if (error) {
    return (
      <div className="agent-screen">
        <button className="agent-button" onClick={onBack}>
          &larr; Back
        </button>
        <p className="agent-error">{error}</p>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="agent-screen">
        <button className="agent-button" onClick={onBack}>
          &larr; Back
        </button>
        <p>Loading...</p>
      </div>
    );
  }

  const workflowUrl = platformUrl ? `${platformUrl.replace(/\/$/, "")}/app/workflows/${workflow.workflowId}` : undefined;

  return (
    <div className="agent-screen">
      <button className="agent-button" onClick={onBack}>
        &larr; Back
      </button>
      <h1>{workflow.name}</h1>
      {offline && <p className="agent-text-muted">Offline -- showing last known data.</p>}
      <p>{statusBanner(workflow)}</p>

      <div className="agent-button-row">
        <button className="agent-button agent-button--primary" disabled={actionPending} onClick={() => runAction("run_now")}>
          Run now
        </button>
        {workflow.status === "paused" ? (
          <button className="agent-button" disabled={actionPending} onClick={() => runAction("resume")}>
            Resume
          </button>
        ) : (
          <button className="agent-button" disabled={actionPending} onClick={() => runAction("pause")}>
            Pause
          </button>
        )}
        {workflowUrl && (
          <a className="agent-button" href={workflowUrl} target="_blank" rel="noreferrer">
            Edit on website
          </a>
        )}
      </div>
      {actionError && <p className="agent-error">{actionError}</p>}

      <div style={{ height: 420, border: "1px solid var(--agent-border)", borderRadius: 6 }}>
        <ReadOnlyCanvas nodes={nodes} edges={edges} />
      </div>

      <h2>Run history</h2>
      {runs.length === 0 ? (
        <p className="agent-text-muted">No runs yet.</p>
      ) : (
        <table className="agent-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Finished</th>
              <th>Status</th>
              <th>Rows sent</th>
              <th>Rows deleted</th>
              <th>Mode</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>{run.startedAt}</td>
                <td>{run.finishedAt}</td>
                <td>{run.status}</td>
                <td>{run.rowsSent}</td>
                <td>{run.rowsDeleted}</td>
                <td>{run.mode ?? ""}</td>
                <td>{run.errorClass ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
