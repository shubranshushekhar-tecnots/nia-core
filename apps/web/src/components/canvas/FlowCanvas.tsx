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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONNECTOR_MANIFESTS } from '@nia/schemas';
import type { WorkflowDetail } from '@/lib/dashboard/types';
import type { Connection } from '@/lib/connections/types';
import {
  buildCanvasNode,
  graphToFlow,
  flowToGraph,
  type CanvasNode,
  type CanvasEdge,
  type MappingContext,
} from '@/lib/canvas/mapping';
import { getWorkflowGraph, putWorkflowGraph, GraphApiError, type WorkflowGraphResult } from '@/lib/api/graphClient';
import { useCanvasStore } from '@/lib/canvas/store';
import GraphFlowNode from './GraphFlowNode';
import PaletteDock, { PALETTE_DRAG_MIME, type PaletteDragPayload } from './PaletteDock';
import { brandTextStyle, breadcrumbSepStyle } from '@/components/app/styles';

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
}: {
  workflow: WorkflowDetail;
  connections: Connection[];
  initialGraph: WorkflowGraphResult;
}) {
  const ctx = useMappingContext(connections);
  const { screenToFlowPosition } = useReactFlow();
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const parkedLegacyTriggers = useRef(data!.graph.parkedLegacyTriggers);

  const saveState = useCanvasStore((s) => s.saveState);
  const setSaveState = useCanvasStore((s) => s.setSaveState);
  const version = useCanvasStore((s) => s.version);
  const setVersion = useCanvasStore((s) => s.setVersion);
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
      setPaletteOpen(false);
    },
    [screenToFlowPosition, ctx, setNodes, edges, scheduleSave],
  );

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
          {/* Non-functional stubs this session — checks/execution arrive in Session 3. */}
          <button type="button" disabled title="Checks arrive in Session 3" style={disabledRunBtnStyle}>
            Run checks
          </button>
          <button type="button" disabled title="Checks arrive in Session 3" style={disabledRunBtnStyle}>
            Run
          </button>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#fff',
              background: 'var(--acc)',
              border: 'none',
              borderRadius: 6,
              padding: '7px 14px',
              cursor: 'pointer',
            }}
          >
            Add node
          </button>
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
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={20} color="var(--dot)" />
        </ReactFlow>
      </div>

      {paletteOpen && <PaletteDock connections={connections} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

export default function FlowCanvas(props: {
  workflow: WorkflowDetail;
  connections: Connection[];
  initialGraph: WorkflowGraphResult;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
