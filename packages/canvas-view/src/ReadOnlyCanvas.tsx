'use client';

import { ReactFlow, ReactFlowProvider, Background, type NodeTypes, type EdgeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ReadOnlyGraphNode from './ReadOnlyGraphNode.js';
import CanvasEdge from './CanvasEdge.js';
import type { ReadOnlyCanvasNode, ReadOnlyCanvasEdge } from './types.js';

// Same registration pattern as apps/web's FlowCanvas.tsx (nodeTypes keyed
// by every GraphNodeType, all pointing at the one card component; a single
// `default` edge type) — just with ReadOnlyGraphNode/CanvasEdge substituted.
const nodeTypes: NodeTypes = {
  source: ReadOnlyGraphNode,
  transform: ReadOnlyGraphNode,
  destination: ReadOnlyGraphNode,
};

const edgeTypes: EdgeTypes = {
  default: CanvasEdge,
};

export type ReadOnlyCanvasProps = {
  nodes: ReadOnlyCanvasNode[];
  edges: ReadOnlyCanvasEdge[];
};

/**
 * Read-only canvas for the agent app's workflow detail screen. No
 * drag/connect affordances (`nodesDraggable`/`nodesConnectable` both
 * false) — only panning, scroll-zoom, and node selection (for a future
 * "inspect this node" affordance) are enabled.
 */
export function ReadOnlyCanvas({ nodes, edges }: ReadOnlyCanvasProps) {
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        zoomOnScroll
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
