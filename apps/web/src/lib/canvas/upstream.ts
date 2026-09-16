import type { CanvasNode, CanvasEdge } from './mapping';

/**
 * Walks backward from a transform node (breadth-first over edges) to find
 * the nearest resolved source node feeding it, for the transform editor's
 * field picker and the pushdown compiler's dialect selection. Stops at the
 * first source node found on any incoming path — v1 doesn't attempt to
 * reconcile fields across multiple joined sources (no join step exists
 * yet).
 */
export function findUpstreamSource(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): { connectionId?: string; manifestId?: string } | undefined {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of edges) {
        if (edge.target !== id || visited.has(edge.source)) continue;
        visited.add(edge.source);
        const upstream = nodesById.get(edge.source);
        if (!upstream) continue;
        if (upstream.data.graphNodeType === 'source') {
          return { connectionId: upstream.data.connectionId, manifestId: upstream.data.manifestId };
        }
        next.push(edge.source);
      }
    }
    frontier = next;
  }
  return undefined;
}
