'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
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
import { CONNECTOR_MANIFESTS, type ActorRole, type Plan, type PlanDiff } from '@nia/schemas';
import type { SidebarProject, WorkflowDetail } from '@/lib/dashboard/types';
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
import { planToGhostFlow, planDiffToGhostFlow } from '@/lib/canvas/ghostMapping';
import { findUpstreamSource } from '@/lib/canvas/upstream';
import { getWorkflowGraph, putWorkflowGraph, GraphApiError, type WorkflowGraphResult } from '@/lib/api/graphClient';
import { applyPlan, applyPlanDiff, listAppliedPlans, revertPlan, CopilotApiError } from '@/lib/api/copilotClient';
import { runWorkflowChecks, getLatestCheckRun, listCheckRuns, ChecksApiError } from '@/lib/api/checksClient';
import { startWorkflowRun, streamRun, cancelWorkflowRun, RunApiError } from '@/lib/api/runsClient';
import { useCanvasStore } from '@/lib/canvas/store';
import { useChatSession } from '@/lib/chat/useChatSession';
import { buildActivityFeed, type ActivityItem } from '@/lib/canvas/activityFeed';
import Logo from '@/components/Logo';
import Sidebar from '@/components/app/Sidebar';
import GraphFlowNode from './GraphFlowNode';
import NodesRail, { PALETTE_DRAG_MIME, type PaletteDragPayload } from './NodesRail';
import NodeConfigPanel from './NodeConfigPanel';
import ChecksDock from './ChecksDock';
import CopilotSidebar from './CopilotSidebar';
import CanvasHeader from './CanvasHeader';
import { breadcrumbSepStyle } from '@/components/app/styles';
import {
  canvasBodyStyle,
  canvasColumnStyle,
  canvasFullscreenWrapStyle,
  canvasPageRootStyle,
  canvasShellRowStyle,
  canvasSurfaceStyle,
  fullViewBreadcrumbStyle,
  fullViewControlsStyle,
  headerCopilotToggleBtnStyle,
  headerRunBtnStyle,
  headerRunChecksBtnStyle,
  planBannerApplyBtnStyle,
  planBannerDiscardBtnStyle,
  planBannerErrorStyle,
  planBannerStyle,
  planBannerTextStyle,
  viewportFullscreenBtnStyle,
  viewportToolbarBtnStyle,
  viewportToolbarDividerStyle,
  viewportToolbarStyle,
} from './styles';

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
  orgId,
  orgName,
  role,
  sidebarProjects,
  email,
  workflow,
  connections,
  initialGraph,
  initialConversation,
  initialMessages,
}: {
  orgId: string | null;
  orgName: string | null;
  role: ActorRole;
  sidebarProjects: SidebarProject[];
  email: string;
  workflow: WorkflowDetail;
  connections: Connection[];
  initialGraph: WorkflowGraphResult;
  initialConversation: Conversation | null;
  initialMessages: ChatMessage[];
}) {
  const ctx = useMappingContext(connections);
  const [copilotOpen, setCopilotOpen] = useState(true);
  const { screenToFlowPosition, setCenter, getNode, zoomIn, zoomOut, fitView } = useReactFlow();
  // Wraps canvas-surface + CopilotSidebar (not just the canvas) so "full
  // view" keeps Copilot visible/usable instead of it disappearing along
  // with everything outside the fullscreened subtree.
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const handler = () => setIsFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      fullscreenRef.current?.requestFullscreen();
    }
  }, []);
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
  const ghostPlan = useCanvasStore((s) => s.ghostPlan);
  const ghostDiff = useCanvasStore((s) => s.ghostDiff);
  const clearGhost = useCanvasStore((s) => s.clearGhost);

  // Phase 7 Session 2 — Copilot ghost overlay. `ghost` is purely a display
  // concern: it is layered on top of (never merged into) `nodes`/`edges`
  // state, so it can never reach handleNodesChange/scheduleSave/
  // flowToGraph and can never be accidentally autosaved. Placement is
  // delegated to plan.ts's computePlanLayout (via planToGhostFlow) against
  // the live canvas's current node positions — same function Apply uses
  // server-side, so nothing ever visually "jumps" between preview and
  // applied state.
  const ghost = useMemo(
    () => (ghostPlan ? planToGhostFlow(ghostPlan, nodes.map((n) => n.position), ctx) : null),
    [ghostPlan, nodes, ctx],
  );
  // Phase 12 — PlanDiff's ghost overlay, parallel to `ghost` above but
  // structurally different: addNode/addEdge ops need genuinely new overlay
  // objects (same isGhost:true treatment `ghost` uses), while
  // removeNode/updateNode/removeEdge ops target REAL, already-committed
  // nodes/edges, so they come back as a nodeId/edgeId -> mark map that gets
  // merged onto the real node/edge data below instead of a separate overlay
  // object (see ghostMapping.ts's planDiffToGhostFlow doc comment).
  const ghostDiffOverlay = useMemo(() => (ghostDiff ? planDiffToGhostFlow(ghostDiff, ctx) : null), [ghostDiff, ctx]);
  const displayNodes = useMemo(() => {
    const marked = ghostDiffOverlay
      ? nodes.map((n) => {
          const mark = ghostDiffOverlay.nodeMarks.get(n.id);
          return mark ? { ...n, data: { ...n.data, ghostDiffStatus: mark.status, ghostDiffLabel: mark.label } } : n;
        })
      : nodes;
    const overlayNodes = [...(ghost?.nodes ?? []), ...(ghostDiffOverlay?.addNodes ?? [])];
    return overlayNodes.length > 0 ? [...marked, ...overlayNodes] : marked;
  }, [nodes, ghost, ghostDiffOverlay]);
  const displayEdges = useMemo(() => {
    const marked = ghostDiffOverlay
      ? edges.map((e) => {
          const mark = ghostDiffOverlay.edgeMarks.get(e.id);
          return mark ? { ...e, style: { ...e.style, opacity: 0.35, strokeDasharray: '4 3' } } : e;
        })
      : edges;
    const overlayEdges = [...(ghost?.edges ?? []), ...(ghostDiffOverlay?.addEdges ?? [])];
    return overlayEdges.length > 0 ? [...marked, ...overlayEdges] : marked;
  }, [edges, ghost, ghostDiffOverlay]);
  // Bring newly-proposed ghost nodes into view without disturbing the
  // user's existing pan/zoom when there's nothing new to show.
  const lastFitGhostPlanRef = useRef<Plan | null>(null);
  useEffect(() => {
    if (!ghost || !ghostPlan || lastFitGhostPlanRef.current === ghostPlan) return;
    lastFitGhostPlanRef.current = ghostPlan;
    fitView({ nodes: ghost.nodes.map((n) => ({ id: n.id })), duration: 400, maxZoom: 1, padding: 0.3 });
  }, [ghost, ghostPlan, fitView]);
  const lastFitGhostDiffRef = useRef<PlanDiff | null>(null);
  useEffect(() => {
    if (!ghostDiffOverlay || !ghostDiff || lastFitGhostDiffRef.current === ghostDiff || ghostDiffOverlay.addNodes.length === 0) return;
    lastFitGhostDiffRef.current = ghostDiff;
    fitView({ nodes: ghostDiffOverlay.addNodes.map((n) => ({ id: n.id })), duration: 400, maxZoom: 1, padding: 0.3 });
  }, [ghostDiffOverlay, ghostDiff, fitView]);

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
          // Read the freshest known version from the store at fire-time,
          // not a React-closure value captured whenever this callback was
          // last (re)created. onNodesChange fires for every node-change
          // event React Flow reports — including cosmetic ones like
          // 'dimensions' measurement, not just real edits — so two
          // scheduleSave calls close enough together to both reference the
          // same stale `version` (e.g. one still in flight when the other's
          // debounce timer fires) previously raced: the first PUT would
          // land and bump the row's version server-side, then the second
          // — sent with the same pre-bump expectedVersion — got a 409 it
          // never retried, silently losing that edit (real repro: dropping
          // a source node then immediately picking its table in the
          // drawer). Version conflicts from another session/tab are still
          // caught correctly, since this always sends the latest value
          // this tab has actually observed.
          const result = await putWorkflowGraph(workflow.id, { graph, expectedVersion: useCanvasStore.getState().version });
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
    [workflow.id],
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
    (_, node) => {
      // Ghost nodes are a read-only preview (see ghostMapping.ts) — clicking
      // one must not open NodeConfigPanel or disturb whatever real node is
      // currently selected.
      if ((node.data as { isGhost?: boolean }).isGhost) return;
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );
  const onPaneClick = useCallback(() => setSelectedNodeId(null), [setSelectedNodeId]);

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : undefined;
  const upstreamSource = selectedNode ? findUpstreamSource(selectedNode.id, nodes, edges) : undefined;
  // React Flow's own marquee/multi-select is left fully intact (untouched)
  // — this just counts it, purely for NodeConfigPanel's "N nodes selected"
  // hint; no new app-level multi-select state is introduced.
  const selectedCount = useMemo(() => nodes.filter((n) => n.selected).length, [nodes]);

  // Escape deselects, but only when focus isn't inside the config panel
  // itself (e.g. a <select> or input) — so it never fights an input's own
  // Escape handling, and canvas-level Escape isn't swallowed when focus is
  // on the canvas. No preventDefault/stopPropagation — other Escape
  // handlers (e.g. an open command palette) still run normally.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[data-node-config-panel]')) return;
      setSelectedNodeId(null);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setSelectedNodeId]);

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

  // Phase 7 Session 3 — Apply. applyPlan() already returns the merged
  // GraphDoc + its new version (services/copilotApply.ts's putWorkflowGraph
  // call), so this mirrors reloadAfterConflict's remap-and-set-state shape
  // without a second fetch. Ghost is only cleared on success — a failure
  // (most notably 409 PLAN_STALE) leaves it in place so the user can retry
  // or explicitly discard (copilotClient.ts's applyPlan doc comment).
  const [applyingPlan, setApplyingPlan] = useState(false);
  const [applyPlanError, setApplyPlanError] = useState<string | null>(null);
  const handleApplyPlan = useCallback(async () => {
    if (!ghostPlan) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setApplyingPlan(true);
    setApplyPlanError(null);
    try {
      const result = await applyPlan(workflow.id, { plan: ghostPlan });
      queryClient.setQueryData(queryKey, result);
      const remapped = graphToFlow(result.graph, ctx);
      setNodes(remapped.nodes);
      setEdges(remapped.edges);
      setVersion(result.version);
      setSaveState('idle');
      clearGhost();
    } catch (err) {
      setApplyPlanError(err instanceof CopilotApiError ? err.message : 'Apply failed — try again.');
    } finally {
      setApplyingPlan(false);
    }
  }, [ghostPlan, workflow.id, queryClient, queryKey, ctx, setNodes, setEdges, setVersion, setSaveState, clearGhost]);

  const handleDiscardPlan = useCallback(() => {
    setApplyPlanError(null);
    clearGhost();
  }, [clearGhost]);

  // Phase 12 — apply-diff, parallel to handleApplyPlan above (that function
  // and the legacy add-only Plan/applyPlan() path are deliberately
  // untouched). Same "failure preserves ghost" contract.
  const [applyingPlanDiff, setApplyingPlanDiff] = useState(false);
  const [applyPlanDiffError, setApplyPlanDiffError] = useState<string | null>(null);
  const appliedPlansQueryKey = useMemo(() => ['workflow-applied-plans', workflow.id], [workflow.id]);
  const { data: appliedPlans } = useQuery({
    queryKey: appliedPlansQueryKey,
    queryFn: () => listAppliedPlans(workflow.id),
    staleTime: Infinity,
  });
  const handleApplyPlanDiff = useCallback(async () => {
    if (!ghostDiff) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setApplyingPlanDiff(true);
    setApplyPlanDiffError(null);
    try {
      const result = await applyPlanDiff(workflow.id, { diff: ghostDiff });
      queryClient.setQueryData(queryKey, result);
      const remapped = graphToFlow(result.graph, ctx);
      setNodes(remapped.nodes);
      setEdges(remapped.edges);
      setVersion(result.version);
      setSaveState('idle');
      clearGhost();
      queryClient.invalidateQueries({ queryKey: appliedPlansQueryKey });
    } catch (err) {
      setApplyPlanDiffError(err instanceof CopilotApiError ? err.message : 'Apply failed — try again.');
    } finally {
      setApplyingPlanDiff(false);
    }
  }, [ghostDiff, workflow.id, queryClient, queryKey, appliedPlansQueryKey, ctx, setNodes, setEdges, setVersion, setSaveState, clearGhost]);

  const handleDiscardPlanDiff = useCallback(() => {
    setApplyPlanDiffError(null);
    clearGhost();
  }, [clearGhost]);

  // Phase 12 — revert. Refusal (409 REVERT_CONFLICT) carries a
  // `{ conflicts: string[] }` details payload (see copilotClient.ts's
  // CopilotApiError) naming which touched elements changed since apply; no
  // automatic merge, the user must resolve manually. Success mirrors
  // handleApplyPlan's remap-and-set-state shape and refreshes the applied-
  // plans list so the reverted entry's reverted_at/revertPlanId show up.
  const [revertingPlanId, setRevertingPlanId] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<{ planId: string; message: string; conflicts?: string[] } | null>(null);
  const handleRevertPlan = useCallback(
    async (planId: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setRevertingPlanId(planId);
      setRevertError(null);
      try {
        const result = await revertPlan(workflow.id, planId);
        queryClient.setQueryData(queryKey, result);
        const remapped = graphToFlow(result.graph, ctx);
        setNodes(remapped.nodes);
        setEdges(remapped.edges);
        setVersion(result.version);
        setSaveState('idle');
        queryClient.invalidateQueries({ queryKey: appliedPlansQueryKey });
      } catch (err) {
        const conflicts =
          err instanceof CopilotApiError && err.code === 'REVERT_CONFLICT'
            ? (err.details as { conflicts?: string[] } | undefined)?.conflicts
            : undefined;
        setRevertError({
          planId,
          message: err instanceof CopilotApiError ? err.message : 'Revert failed — try again.',
          conflicts,
        });
      } finally {
        setRevertingPlanId(null);
      }
    },
    [workflow.id, queryClient, queryKey, appliedPlansQueryKey, ctx, setNodes, setEdges, setVersion, setSaveState],
  );

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
  const [checksDockHeight, setChecksDockHeight] = useState(36);
  const [checksDockTab, setChecksDockTab] = useState<'checks' | 'logs'>('checks');

  // Execution (Phase 6 Block 3; Block 5 — multi-destination fan-out). Each
  // destination node runs independently (own runId/checkpoint/stream — see
  // apps/api/src/services/runs.ts's startWorkflowRun), so run state is keyed
  // by destNodeId rather than a single flat RunState.
  type RunState =
    | { status: 'starting' }
    | { status: 'running'; totalRowsProcessed: number }
    | { status: 'cancelling'; totalRowsProcessed: number }
    | { status: 'cancelled'; totalRowsProcessed: number }
    | { status: 'done'; totalRowsProcessed: number; durationMs: number }
    | { status: 'error'; message: string };
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const runTeardownsRef = useRef<Record<string, () => void>>({});
  // Block 3.5 item 3 — the currently in-flight runId per destination, kept
  // outside RunState since cancel needs it regardless of which sub-state
  // (running vs cancelling) the UI is in; cleared on every terminal event.
  const runIdByDestRef = useRef<Record<string, string>>({});
  useEffect(
    () => () => {
      for (const teardown of Object.values(runTeardownsRef.current)) teardown();
    },
    [],
  );

  // Block 3.5 item 4 — Logs tab's `kind: 'run'` source. Reuses the same SSE
  // events already driving the run-status panel above rather than a
  // separate "list past runs" read (no such endpoint exists yet); scoped
  // to the current run session, not full historical run listing. Progress
  // events are throttled (min 3s apart) so a fast chunk loop doesn't flood
  // the feed — start/terminal events always log immediately.
  const [runActivity, setRunActivity] = useState<ActivityItem[]>([]);
  const lastProgressLogRef = useRef(0);
  const logRunActivity = useCallback((text: string) => {
    setRunActivity((prev) => [...prev, { time: new Date().toISOString(), text, kind: 'run' }]);
  }, []);

  const destinationNodes = useMemo(() => nodes.filter((n) => n.data.graphNodeType === 'destination'), [nodes]);
  // Block 5: every destination node in the graph runs, not just "the" one —
  // the old single-destination-per-run scope cut is gone (see docs/
  // decisions.md's Block 5 entry). Labeled by the destination's connection
  // handle for the per-run status cards below.
  const runNodeIds = useMemo(() => destinationNodes.map((n) => n.id), [destinationNodes]);
  const destLabel = useCallback(
    (destNodeId: string) => {
      const node = destinationNodes.find((n) => n.id === destNodeId);
      const connectionId = node?.data.connectionId;
      return (connectionId && ctx.connectionsById.get(connectionId)?.handle) || destNodeId.slice(0, 8);
    },
    [destinationNodes, ctx.connectionsById],
  );

  const handleRun = useCallback(async () => {
    if (runNodeIds.length === 0) return;
    for (const teardown of Object.values(runTeardownsRef.current)) teardown();
    runTeardownsRef.current = {};
    runIdByDestRef.current = {};
    lastProgressLogRef.current = 0;
    setRunStates(Object.fromEntries(runNodeIds.map((id) => [id, { status: 'starting' } as RunState])));
    try {
      const { runs } = await startWorkflowRun(workflow.id, runNodeIds);
      for (const { destNodeId, runId } of runs) {
        runIdByDestRef.current[destNodeId] = runId;
        runTeardownsRef.current[destNodeId] = streamRun(workflow.id, runId, {
          onEvent: (event) => {
            if (event.type === 'started') {
              setRunStates((prev) => ({ ...prev, [destNodeId]: { status: 'running', totalRowsProcessed: 0 } }));
              logRunActivity(`Run started — ${destLabel(destNodeId)}`);
            } else if (event.type === 'progress') {
              setRunStates((prev) => ({
                ...prev,
                [destNodeId]: {
                  status: prev[destNodeId]?.status === 'cancelling' ? 'cancelling' : 'running',
                  totalRowsProcessed: event.totalRowsProcessed,
                },
              }));
              const now = Date.now();
              if (now - lastProgressLogRef.current >= 3000) {
                lastProgressLogRef.current = now;
                logRunActivity(`Run progress — ${destLabel(destNodeId)} — ${event.totalRowsProcessed.toLocaleString()} rows`);
              }
            } else if (event.type === 'done') {
              delete runIdByDestRef.current[destNodeId];
              setRunStates((prev) => ({
                ...prev,
                [destNodeId]: { status: 'done', totalRowsProcessed: event.totalRowsProcessed, durationMs: event.durationMs },
              }));
              logRunActivity(
                `Run complete — ${destLabel(destNodeId)} — ${event.totalRowsProcessed.toLocaleString()} rows in ${(event.durationMs / 1000).toFixed(1)}s`,
              );
            } else if (event.type === 'error') {
              delete runIdByDestRef.current[destNodeId];
              setRunStates((prev) => ({ ...prev, [destNodeId]: { status: 'error', message: event.message } }));
              logRunActivity(`Run failed — ${destLabel(destNodeId)} — ${event.message}`);
            } else if (event.type === 'cancel') {
              delete runIdByDestRef.current[destNodeId];
              setRunStates((prev) => ({
                ...prev,
                [destNodeId]: {
                  status: 'cancelled',
                  totalRowsProcessed:
                    prev[destNodeId]?.status === 'running' || prev[destNodeId]?.status === 'cancelling'
                      ? (prev[destNodeId] as { totalRowsProcessed: number }).totalRowsProcessed
                      : 0,
                },
              }));
              logRunActivity(`Run cancelled — ${destLabel(destNodeId)}`);
            }
          },
          onTransportError: () =>
            setRunStates((prev) => ({ ...prev, [destNodeId]: { status: 'error', message: 'Lost connection to the run stream.' } })),
        });
      }
    } catch (err) {
      const message = err instanceof RunApiError ? err.message : 'Failed to start the run.';
      setRunStates(Object.fromEntries(runNodeIds.map((id) => [id, { status: 'error', message } as RunState])));
    }
  }, [workflow.id, runNodeIds, logRunActivity, destLabel]);

  // Block 3.5 item 3 — cooperative cancel, per destination. Doesn't set
  // 'cancelled' itself: the worker only actually stops between chunks
  // (runEtl.ts's checkpoint poll), and the run stream's own `cancel` event
  // (handled in handleRun's onEvent above) is the sole source of truth for
  // when that's happened. This only flips workflow_runs.status and shows an
  // interim "Cancelling…" state so the card doesn't look inert while that's
  // in flight.
  const handleCancel = useCallback(
    async (destNodeId: string) => {
      const runId = runIdByDestRef.current[destNodeId];
      if (!runId) return;
      setRunStates((prev) => ({
        ...prev,
        [destNodeId]: {
          status: 'cancelling',
          totalRowsProcessed:
            prev[destNodeId]?.status === 'running' || prev[destNodeId]?.status === 'cancelling'
              ? (prev[destNodeId] as { totalRowsProcessed: number }).totalRowsProcessed
              : 0,
        },
      }));
      try {
        await cancelWorkflowRun(workflow.id, runId);
      } catch (err) {
        setRunStates((prev) => ({
          ...prev,
          [destNodeId]: { status: 'error', message: err instanceof RunApiError ? err.message : 'Failed to cancel the run.' },
        }));
      }
    },
    [workflow.id],
  );

  const dismissRun = useCallback((destNodeId: string) => {
    setRunStates((prev) => {
      const next = { ...prev };
      delete next[destNodeId];
      return next;
    });
  }, []);

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
    () => buildActivityFeed(checkRunsHistory ?? [], chatSession.messages, runActivity),
    [checkRunsHistory, chatSession.messages, runActivity],
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

  // Run (workflow execution, Phase 6 Block 3; Block 5 — multi-destination
  // fan-out). Enabled only when the latest persisted check run is all-pass
  // AND matches the live graph_version (checksStale below), AND the graph
  // has at least one destination node. Mapping/entity/upsert-key
  // completeness is NOT re-validated here — the worker validates all of
  // that itself, per destination, and surfaces a clean `error` stream event
  // rather than silently failing, so duplicating that check here would just
  // be a second place to keep in sync.
  const checksStale = !latestCheckRun || latestCheckRun.graphVersion !== version;
  const failingChecks = latestCheckRun?.results.filter((r) => r.status === 'fail').length ?? 0;
  const runInFlight = Object.values(runStates).some(
    (s) => s.status === 'starting' || s.status === 'running' || s.status === 'cancelling',
  );
  const runEnabled = !checksStale && failingChecks === 0 && runNodeIds.length > 0 && !runInFlight;
  // Block 3.5 item 2: checkConfig's source-entity-missing case stays a
  // `warn` (see checks.ts's amended comment), so an unset entity never
  // blocks Run at the enabled/disabled level — but the run itself WILL
  // hard-fail on it (runEtl.ts), unlike preview's silent inference. Surface
  // that consequence here instead, so a passing-with-warnings run doesn't
  // start only to immediately error.
  const unsetEntityWarning = latestCheckRun?.results.some(
    (r) => r.status === 'warn' && r.id === 'config' && r.message.includes('no table selected'),
  );
  const runTooltip = checksStale
    ? 'Run checks before running the workflow.'
    : failingChecks > 0
      ? `${failingChecks} check${failingChecks === 1 ? '' : 's'} failing — fix before running.`
      : runNodeIds.length === 0
        ? 'Add a destination node before running.'
        : runInFlight
          ? 'A run is already in progress.'
          : unsetEntityWarning
            ? 'A source node has no table selected — the run will fail unless you pick one explicitly.'
            : runNodeIds.length > 1
              ? `Runs all ${runNodeIds.length} destinations.`
              : 'All checks passing.';

  return (
    <div style={canvasPageRootStyle} data-app-theme="" data-om-theme="light">
      <CanvasHeader
        orgName={orgName}
        projectName={workflow.project.name}
        projectHref={`/app/projects/${workflow.project.id}`}
        workflowName={workflow.name}
        saveState={saveState}
        onReloadAfterConflict={reloadAfterConflict}
        checksRunning={checksRunning}
        onRunChecks={handleRunChecks}
        runEnabled={runEnabled}
        runInFlight={runInFlight}
        runTooltip={runTooltip}
        onRun={handleRun}
        copilotOpen={copilotOpen}
        onToggleCopilot={() => setCopilotOpen((v) => !v)}
      />

      <div style={canvasShellRowStyle}>
        <Sidebar orgId={orgId} role={role} projects={sidebarProjects} email={email} />

        <div style={canvasBodyStyle}>
        <NodesRail connections={connections} />

        <div ref={fullscreenRef} style={canvasFullscreenWrapStyle}>
          <div style={canvasColumnStyle}>
            <NodeConfigPanel
              node={selectedNode}
              selectedCount={selectedCount}
              workflowId={workflow.id}
              upstreamSource={upstreamSource}
              checkResults={latestCheckRun?.results ?? null}
              onConfigChange={updateSelectedNodeConfig}
              onDelete={deleteSelectedNode}
              onClose={onPaneClick}
            />

            <div
              data-testid="canvas-surface"
              style={canvasSurfaceStyle}
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
            >
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
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
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="var(--canvas-dot)" bgColor="var(--canvas)" />
              <MiniMap
                pannable
                zoomable
                maskColor="rgba(15,23,42,.06)"
                style={{ background: 'var(--surface)', border: '1px solid var(--panel-line)', borderRadius: 10 }}
              />
            </ReactFlow>

            {ghostPlan && (
              <div style={planBannerStyle} data-testid="plan-banner">
                <span style={planBannerTextStyle}>{ghostPlan.summary}</span>
                {applyPlanError && <span style={planBannerErrorStyle}>{applyPlanError}</span>}
                <button
                  type="button"
                  style={planBannerDiscardBtnStyle}
                  onClick={handleDiscardPlan}
                  disabled={applyingPlan}
                  data-testid="plan-banner-discard"
                >
                  Discard
                </button>
                <button
                  type="button"
                  style={planBannerApplyBtnStyle}
                  onClick={handleApplyPlan}
                  disabled={applyingPlan}
                  data-testid="plan-banner-apply"
                >
                  {applyingPlan ? 'Applying…' : 'Apply'}
                </button>
              </div>
            )}

            {ghostDiff && (
              <div style={planBannerStyle} data-testid="plan-diff-banner">
                <span style={planBannerTextStyle}>{ghostDiff.summary}</span>
                {applyPlanDiffError && <span style={planBannerErrorStyle}>{applyPlanDiffError}</span>}
                <button
                  type="button"
                  style={planBannerDiscardBtnStyle}
                  onClick={handleDiscardPlanDiff}
                  disabled={applyingPlanDiff}
                  data-testid="plan-diff-banner-discard"
                >
                  Discard
                </button>
                <button
                  type="button"
                  style={planBannerApplyBtnStyle}
                  onClick={handleApplyPlanDiff}
                  disabled={applyingPlanDiff}
                  data-testid="plan-diff-banner-apply"
                >
                  {applyingPlanDiff ? 'Applying…' : 'Apply'}
                </button>
              </div>
            )}

            {/* Full-view floating controls — the merged header (and the icon
                rail) live outside fullscreenRef, so both disappear once the
                Fullscreen API is engaged. Mirrors CanvasHeader's breadcrumb
                and copilot/checks/run actions in a minimal floating form so
                the workflow stays fully operable in full view. Exiting full
                view is already covered by the viewport toolbar's fullscreen
                toggle below. */}
            {isFullscreen && (
              <div style={fullViewBreadcrumbStyle} data-testid="full-view-breadcrumb">
                <span>{workflow.project.name}</span>
                <span style={breadcrumbSepStyle}>/</span>
                <span style={{ fontWeight: 600 }}>{workflow.name}</span>
                {saveState !== 'conflict' && saveState !== 'idle' && (
                  <>
                    <span style={breadcrumbSepStyle}>·</span>
                    <span style={{ color: 'var(--ink4)' }}>{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
                  </>
                )}
              </div>
            )}

            {isFullscreen && (
              <div style={fullViewControlsStyle} data-testid="full-view-controls">
                <button
                  type="button"
                  style={headerCopilotToggleBtnStyle(copilotOpen)}
                  onClick={() => setCopilotOpen((v) => !v)}
                  aria-pressed={copilotOpen}
                  title={copilotOpen ? 'Hide Nia AI' : 'Show Nia AI'}
                >
                  <Logo size={16} showWordmark={false} />
                </button>
                <button type="button" onClick={handleRunChecks} disabled={checksRunning} style={headerRunChecksBtnStyle(checksRunning)}>
                  {checksRunning ? 'Running…' : 'Run checks'}
                </button>
                {runEnabled ? (
                  <button type="button" onClick={handleRun} title={runTooltip} style={headerRunBtnStyle(true, runInFlight)}>
                    Run
                  </button>
                ) : (
                  <button type="button" disabled title={runTooltip} style={headerRunBtnStyle(false, runInFlight)}>
                    {runInFlight ? 'Running…' : 'Run'}
                  </button>
                )}
              </div>
            )}

            <div style={viewportToolbarStyle(checksDockHeight)} data-testid="viewport-toolbar">
              <button type="button" style={viewportToolbarBtnStyle} onClick={() => zoomOut()} aria-label="Zoom out" title="Zoom out">
                {'\u2212'}
              </button>
              <button type="button" style={viewportToolbarBtnStyle} onClick={() => zoomIn()} aria-label="Zoom in" title="Zoom in">
                {'+'}
              </button>
              <button
                type="button"
                style={viewportToolbarBtnStyle}
                onClick={() => fitView({ maxZoom: 1, duration: 300 })}
                aria-label="Fit view"
                title="Fit view"
              >
                {'\u2317'}
              </button>
              <div style={viewportToolbarDividerStyle} />
              <button
                type="button"
                style={viewportFullscreenBtnStyle(isFullscreen)}
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? 'Exit full view' : 'Full view'}
                title={isFullscreen ? 'Exit full view' : 'Full view'}
              >
                <span aria-hidden>{isFullscreen ? '\u2716' : '\u26F6'}</span>
                {isFullscreen ? 'Exit full view' : 'Full view'}
              </button>
            </div>

            <ChecksDock
              running={checksRunning}
              error={checksError}
              results={latestCheckRun?.results ?? null}
              ranAt={latestCheckRun?.ranAt ?? null}
              stale={checksStale}
              expanded={checksDockExpanded}
              onToggleExpanded={() => setChecksDockExpanded((v) => !v)}
              onHeightChange={setChecksDockHeight}
              onSelectNode={handleSelectCheckNode}
              activeTab={checksDockTab}
              onTabChange={setChecksDockTab}
              logs={activityFeed}
            />

            {Object.keys(runStates).length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  right: 16,
                  bottom: 16,
                  zIndex: 30,
                  width: 300,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                {Object.entries(runStates).map(([destNodeId, runState]) => (
                  <div
                    key={destNodeId}
                    style={{
                      boxSizing: 'border-box',
                      padding: '14px 16px',
                      borderRadius: 10,
                      background: 'var(--surface)',
                      border: `1px solid ${runState.status === 'error' ? 'var(--bad)' : 'var(--line2)'}`,
                      boxShadow: 'var(--shadow)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>
                        {destLabel(destNodeId)} —{' '}
                        {runState.status === 'starting' && 'Starting run…'}
                        {runState.status === 'running' && 'Running…'}
                        {runState.status === 'cancelling' && 'Cancelling…'}
                        {runState.status === 'cancelled' && 'Cancelled'}
                        {runState.status === 'done' && 'Complete'}
                        {runState.status === 'error' && 'Failed'}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {runState.status === 'running' && (
                          <button
                            type="button"
                            onClick={() => handleCancel(destNodeId)}
                            style={{
                              border: '1px solid var(--line2)',
                              background: 'none',
                              color: 'var(--ink3)',
                              cursor: 'pointer',
                              fontSize: 11.5,
                              fontWeight: 600,
                              borderRadius: 5,
                              padding: '2px 8px',
                            }}
                          >
                            Cancel
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label="Dismiss"
                          onClick={() => dismissRun(destNodeId)}
                          style={{ border: 'none', background: 'none', color: 'var(--ink4)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                        >
                          {'\u2715'}
                        </button>
                      </div>
                    </div>
                    {(runState.status === 'running' ||
                      runState.status === 'cancelling' ||
                      runState.status === 'cancelled' ||
                      runState.status === 'done') && (
                      <span style={{ fontSize: 12, color: 'var(--ink3)' }}>
                        {runState.totalRowsProcessed.toLocaleString()} row{runState.totalRowsProcessed === 1 ? '' : 's'} written
                        {runState.status === 'done' ? ` in ${(runState.durationMs / 1000).toFixed(1)}s` : ''}
                      </span>
                    )}
                    {runState.status === 'error' && <span style={{ fontSize: 12, color: 'var(--bad)' }}>{runState.message}</span>}
                  </div>
                ))}
              </div>
            )}
            </div>
          </div>
        </div>

          <CopilotSidebar
            open={copilotOpen}
            onToggle={() => setCopilotOpen((v) => !v)}
            workflowId={workflow.id}
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
            appliedPlans={appliedPlans ?? []}
            onRevertPlan={handleRevertPlan}
            revertingPlanId={revertingPlanId}
            revertError={revertError}
          />
        </div>
      </div>
    </div>
  );
}

export default function FlowCanvas(props: {
  orgId: string | null;
  orgName: string | null;
  role: ActorRole;
  sidebarProjects: SidebarProject[];
  email: string;
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
