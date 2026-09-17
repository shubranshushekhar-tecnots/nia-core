'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection as RFConnection,
  type OnConnect,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import type { WorkflowDetail } from '@/lib/dashboard/types';
import type { Connection } from '@/lib/connections/types';
import type { ChatMessage, Conversation } from '@/lib/api/chatServer';
import {
  buildCanvasNode,
  graphToFlow,
  flowToGraph,
  type CanvasNode,
  type CanvasEdge,
  type MappingContext,
} from '@/lib/canvas/mapping';
import { findUpstreamSource } from '@/lib/canvas/upstream';
import { getWorkflowGraph, putWorkflowGraph, GraphApiError, type WorkflowGraphResult } from '@/lib/api/graphClient';
import { runWorkflowChecks, getLatestCheckRun, listCheckRuns, ChecksApiError } from '@/lib/api/checksClient';
import { useCanvasStore } from '@/lib/canvas/store';
import { useChatSession } from '@/lib/chat/useChatSession';
import { buildActivityFeed } from '@/lib/canvas/activityFeed';
import GraphFlowNode from './GraphFlowNode';
import NodesRail, { PALETTE_DRAG_MIME, type PaletteDragPayload } from './NodesRail';
import NodeDrawer from './NodeDrawer';
import ChecksDock from './ChecksDock';
import CommandBar from './CommandBar';
import {
  brandTextStyle,
  breadcrumbSepStyle,
  modalOverlayStyle,
  modalCardStyle,
  modalTitleStyle,
  modalActionsStyle,
  modalBtnGhostStyle,
} from '@/components/app/styles';

const nodeTypes = { source: GraphFlowNode, transform: GraphFlowNode, destination: GraphFlowNode };
const AUTOSAVE_DELAY_MS = 800;

function useMappingContext(connections: Connection[]): MappingContext {
  return useMemo(
    () => ({
      manifests: CONNECTOR_MANIFESTS,
      connectionsById: new Map(connections.map((c) => [c.id, c])),
    }),
    [connections],
  );
}

function CanvasInner({
  workflow,
  connections,
  initialGraph,
  initialConversation,
  initialMessages,
}: {
  workflow: WorkflowDetail;
  connections: Connection[];
  initialGraph: WorkflowGraphResult;
  initialConversation: Conversation | null;
  initialMessages: ChatMessage[];
}) {
  const ctx = useMappingContext(connections);
  const { screenToFlowPosition, setCenter, getNode } = useReactFlow();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['workflow-graph', workflow.id], [workflow.id]);

  const { data } = useQuery({
    queryKey,
    queryFn: () => getWorkflowGraph(workflow.id),
    initialData: initialGraph,
    staleTime: Infinity,
  });

  const initial = useMemo(() => graphToFlow(data!.graph, ctx), [data, ctx]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CanvasEdge>(initial.edges);
  const parkedLegacyTriggers = useRef(data!.graph.parkedLegacyTriggers);

  const saveState = useCanvasStore((s) => s.saveState);
  const setSaveState = useCanvasStore((s) => s.setSaveState);
  const version = useCanvasStore((s) => s.version);
  const setVersion = useCanvasStore((s) => s.setVersion);
  const selectedNodeId = useCanvasStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useCanvasStore((s) => s.setSelectedNodeId);
  const versionInitialized = useRef(false);
  if (!versionInitialized.current) {
    setVersion(data!.version);
    versionInitialized.current = true;
  }

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback(
    (nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaveState('saving');
        const graph = flowToGraph(nextNodes, nextEdges, parkedLegacyTriggers.current);
        try {
          const result = await putWorkflowGraph(workflow.id, { graph, expectedVersion: version });
          setVersion(result.version);
          setSaveState('saved');
          setTimeout(() => {
            if (useCanvasStore.getState().saveState === 'saved') setSaveState('idle');
          }, 1500);
        } catch (error) {
          if (error instanceof GraphApiError && error.status === 409) {
            setSaveState('conflict');
          } else {
            setSaveState('idle');
          }
        }
      }, AUTOSAVE_DELAY_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workflow.id, version],
  );

  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      setNodes((current) => {
        scheduleSave(current, edges);
        return current;
      });
    },
    [onNodesChange, setNodes, edges, scheduleSave],
  );

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      setEdges((current) => {
        scheduleSave(nodes, current);
        return current;
      });
    },
    [onEdgesChange, setEdges, nodes, scheduleSave],
  );

  const onConnect: OnConnect = useCallback(
    (connection: RFConnection) => {
      setEdges((current) => {
        const next = addEdge(connection, current);
        scheduleSave(nodes, next);
        return next;
      });
    },
    [setEdges, nodes, scheduleSave],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData(PALETTE_DRAG_MIME);
      if (!raw) return;
      const payload = JSON.parse(raw) as PaletteDragPayload;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const newNode = buildCanvasNode(
        {
          id: crypto.randomUUID(),
          graphNodeType: payload.graphNodeType,
          manifestId: payload.manifestId,
          connectionId: payload.connectionId,
          position,
        },
        ctx,
      );
      setNodes((current) => {
        const next = [...current, newNode];
        scheduleSave(next, edges);
        return next;
      });
    },
    [screenToFlowPosition, ctx, setNodes, edges, scheduleSave],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => setSelectedNodeId(node.id),
    [setSelectedNodeId],
  );
  const onPaneClick = useCallback(() => setSelectedNodeId(null), [setSelectedNodeId]);

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : undefined;
  const upstreamSource = selectedNode ? findUpstreamSource(selectedNode.id, nodes, edges) : undefined;

  // Every connectionId currently wired into the canvas (source + destination
  // nodes' data.connectionId) — the command bar's scope fallback when
  // nothing is selected and nothing is @-pinned.
  const wiredConnectionIds = useMemo(
    () => Array.from(new Set(nodes.map((n) => n.data.connectionId).filter((id): id is string => !!id))),
    [nodes],
  );

  const updateSelectedNodeConfig = useCallback(
    (config: Record<string, unknown>) => {
      if (!selectedNodeId) return;
      setNodes((current) => {
        const next = current.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, config } } : n));
        scheduleSave(next, edges);
        return next;
      });
    },
    [selectedNodeId, setNodes, edges, scheduleSave],
  );

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    setSelectedNodeId(null);
    setNodes((current) => {
      const next = current.filter((n) => n.id !== selectedNodeId);
      setEdges((currentEdges) => {
        const nextEdges = currentEdges.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId);
        scheduleSave(next, nextEdges);
        return nextEdges;
      });
      return next;
    });
  }, [selectedNodeId, setSelectedNodeId, setNodes, setEdges, scheduleSave]);

  const reloadAfterConflict = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const fresh = await getWorkflowGraph(workflow.id);
    queryClient.setQueryData(queryKey, fresh);
    const remapped = graphToFlow(fresh.graph, ctx);
    setNodes(remapped.nodes);
    setEdges(remapped.edges);
    setVersion(fresh.version);
    setSaveState('idle');
  }, [workflow.id, queryClient, queryKey, ctx, setNodes, setEdges, setVersion, setSaveState]);

  // Checks (Phase 5 Session 3 Task 2). Latest persisted run is fetched once
  // on mount (GET .../checks/latest, never re-runs anything); "Run checks"
  // POSTs a fresh run and blocks (see checksClient.ts's header comment on
  // why — the worker's BullMQ job is awaited synchronously by Express).
  const checksQueryKey = useMemo(() => ['workflow-checks-latest', workflow.id], [workflow.id]);
  const { data: latestCheckRun } = useQuery({
    queryKey: checksQueryKey,
    queryFn: () => getLatestCheckRun(workflow.id),
    staleTime: Infinity,
  });
  const [checksRunning, setChecksRunning] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [checksDockExpanded, setChecksDockExpanded] = useState(false);
  const [checksDockTab, setChecksDockTab] = useState<'checks' | 'logs'>('checks');
  const [showPhase6Stub, setShowPhase6Stub] = useState(false);

  // Command bar's chat session (Phase 5 Session 4) — lifted up from
  // CommandBar.tsx itself so its live `messages` can also feed the Logs
  // tab's merged activity feed below, rather than a second fetch/duplicate
  // session state.
  const chatSession = useChatSession({
    conversationId: initialConversation?.id,
    initialMessages,
    workflowId: workflow.id,
  });

  // Logs tab (Phase 5 Session 4) — full check-run history, merged with the
  // chat thread's user questions into a single newest-first feed.
  const checkRunsQueryKey = useMemo(() => ['workflow-checks-history', workflow.id], [workflow.id]);
  const { data: checkRunsHistory } = useQuery({
    queryKey: checkRunsQueryKey,
    queryFn: () => listCheckRuns(workflow.id),
    staleTime: Infinity,
  });
  const activityFeed = useMemo(
    () => buildActivityFeed(checkRunsHistory ?? [], chatSession.messages),
    [checkRunsHistory, chatSession.messages],
  );

  const handleRunChecks = useCallback(async () => {
    setChecksDockExpanded(true);
    setChecksRunning(true);
    setChecksError(null);
    try {
      const result = await runWorkflowChecks(workflow.id);
      queryClient.setQueryData(checksQueryKey, result);
      // Fresh run should show up in the Logs tab immediately, not just on
      // next reload — re-fetch the history rather than hand-merge a single
      // row into the cache (listCheckRuns is cheap, capped at 20 rows).
      queryClient.invalidateQueries({ queryKey: checkRunsQueryKey });
    } catch (error) {
      setChecksError(error instanceof ChecksApiError ? error.message : 'Checks failed to run.');
    } finally {
      setChecksRunning(false);
    }
  }, [workflow.id, queryClient, checksQueryKey, checkRunsQueryKey]);

  const handleSelectCheckNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      // Mirror what React Flow's own click-to-select does for a direct node
      // click (onNodeClick above never touches this either — React Flow
      // manages it internally on pointerdown) — a checks-dock row click
      // never reaches the canvas's pointer handling, so the node's
      // `selected` flag (which GraphFlowNode's NodeProps.selected reads for
      // its highlight border, and which drives the `.react-flow__node.selected`
      // CSS class) has to be set explicitly here instead.
      setNodes((current) => current.map((n) => ({ ...n, selected: n.id === nodeId })));
      const node = getNode(nodeId);
      if (!node) return;
      const width = node.measured?.width ?? 200;
      const height = node.measured?.height ?? 80;
      setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: 1, duration: 300 });
    },
    [setSelectedNodeId, setNodes, getNode, setCenter],
  );

  // Run (workflow execution) has no backing route yet (Phase 6) — clicking
  // it while enabled shows a stub modal instead of creating any run rows.
  // The gate itself is real: enabled only when the latest persisted check
  // run is all-pass AND matches the live graph_version (checksStale below),
  // proving the gate works even though execution itself doesn't exist yet.
  const checksStale = !latestCheckRun || latestCheckRun.graphVersion !== version;
  const failingChecks = latestCheckRun?.results.filter((r) => r.status === 'fail').length ?? 0;
  const runEnabled = !checksStale && failingChecks === 0;
  const runTooltip = checksStale
    ? 'Run checks before running the workflow.'
    : failingChecks > 0
      ? `${failingChecks} check${failingChecks === 1 ? '' : 's'} failing — fix before running.`
      : 'All checks passing.';

  const disabledRunBtnStyle = {
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--ink4)',
    background: 'var(--surface2)',
    border: '1px solid var(--line2)',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: 'not-allowed',
  } as const;

  const enabledRunBtnStyle = {
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--onacc)',
    background: 'var(--acc)',
    border: '1px solid var(--acc)',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: 'pointer',
  } as const;

  const runChecksBtnStyle = {
    fontSize: 12.5,
    fontWeight: 600,
    color: 'var(--ink)',
    background: 'var(--surface2)',
    border: '1px solid var(--line2)',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: checksRunning ? 'wait' : 'pointer',
    opacity: checksRunning ? 0.6 : 1,
  } as const;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--canvas)' }}>
      <header
        style={{
          height: 52,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 16px',
          borderBottom: '1px solid var(--line2)',
          background: 'var(--surface)',
        }}
      >
        <a href="/app" style={brandTextStyle}>
          {workflow.project.name}
        </a>
        <span style={breadcrumbSepStyle}>/</span>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{workflow.name}</span>
        {saveState !== 'conflict' && saveState !== 'idle' && (
          <>
            <span style={breadcrumbSepStyle}>·</span>
            <span style={{ fontSize: 12, color: 'var(--ink4)' }}>
              {saveState === 'saving' ? 'Saving…' : 'Saved'}
            </span>
          </>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {saveState === 'conflict' && (
            <button
              type="button"
              onClick={reloadAfterConflict}
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--bad)',
                background: 'var(--warn-bg)',
                border: '1px solid var(--warn-bd)',
                borderRadius: 6,
                padding: '5px 10px',
                cursor: 'pointer',
              }}
            >
              Saved elsewhere — reload
            </button>
          )}
          <button type="button" onClick={handleRunChecks} disabled={checksRunning} style={runChecksBtnStyle}>
            {checksRunning ? 'Running…' : 'Run checks'}
          </button>
          {/* Execution (Phase 6) has no backing route yet. Enabled only
              when the latest check run is all-pass and matches the live
              graph version; clicking while enabled shows a stub — no run
              rows are created. Disabled states keep honest tooltips. */}
          {runEnabled ? (
            <button
              type="button"
              onClick={() => setShowPhase6Stub(true)}
              title={runTooltip}
              style={enabledRunBtnStyle}
            >
              Run
            </button>
          ) : (
            <button type="button" disabled title={runTooltip} style={disabledRunBtnStyle}>
              Run
            </button>
          )}
        </div>
      </header>

      <div
        data-testid="canvas-surface"
        style={{ flex: 1, position: 'relative' }}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView
          // A brand-new workflow mounts with zero nodes (workflow_graphs has
          // no row yet — see seed.sql's comment on 'Canvas E2E Workflow').
          // fitView's computed zoom for a degenerate/empty bounding box
          // falls back to its default maxZoom (2), so the very first node a
          // user drops renders at 200% — clamp it to 1 so an empty canvas
          // never starts zoomed in.
          fitViewOptions={{ maxZoom: 1 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} color="var(--dot)" />
        </ReactFlow>

        <NodesRail connections={connections} />

        <CommandBar
          connections={connections}
          wiredConnectionIds={wiredConnectionIds}
          selectedConnectionId={selectedNode?.data.connectionId ?? null}
          messages={chatSession.messages}
          streamStage={chatSession.streamStage}
          sending={chatSession.sending}
          transportError={chatSession.transportError}
          send={chatSession.send}
          retry={chatSession.retry}
          resetConversation={chatSession.resetConversation}
          checksDockExpanded={checksDockExpanded}
        />

        <ChecksDock
          running={checksRunning}
          error={checksError}
          results={latestCheckRun?.results ?? null}
          ranAt={latestCheckRun?.ranAt ?? null}
          stale={checksStale}
          expanded={checksDockExpanded}
          onToggleExpanded={() => setChecksDockExpanded((v) => !v)}
          onSelectNode={handleSelectCheckNode}
          activeTab={checksDockTab}
          onTabChange={setChecksDockTab}
          logs={activityFeed}
        />

        {selectedNode && (
          <NodeDrawer
            key={selectedNode.id}
            node={selectedNode}
            workflowId={workflow.id}
            upstreamSource={upstreamSource}
            checkResults={latestCheckRun?.results ?? null}
            onConfigChange={updateSelectedNodeConfig}
            onDelete={deleteSelectedNode}
            onClose={onPaneClick}
          />
        )}

        {showPhase6Stub && (
          <div style={modalOverlayStyle} onClick={() => setShowPhase6Stub(false)}>
            <div style={modalCardStyle} onClick={(e) => e.stopPropagation()}>
              <span style={modalTitleStyle}>Execution arrives in Phase 6</span>
              <p style={{ fontSize: 13.5, color: 'var(--text-3)', margin: 0 }}>
                Checks are passing and up to date, so the Run gate is open — but workflow execution itself isn&apos;t
                built yet. No run was started.
              </p>
              <div style={modalActionsStyle}>
                <button type="button" style={modalBtnGhostStyle} onClick={() => setShowPhase6Stub(false)}>
                  Got it
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function FlowCanvas(props: {
  workflow: WorkflowDetail;
  connections: Connection[];
  initialGraph: WorkflowGraphResult;
  initialConversation: Conversation | null;
  initialMessages: ChatMessage[];
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
