import { parseNodeConfig, type EntityRef } from '@nia/schemas';
import type { CanvasNode, CanvasEdge } from './mapping';

/**
 * Walks backward from a transform node (breadth-first over edges) to find
 * the nearest resolved source node feeding it, for the transform editor's
 * field picker and the pushdown compiler's dialect selection. Stops at the
 * first source node found on any incoming path — v1 doesn't attempt to
 * reconcile fields across multiple joined sources (no join step exists
 * yet).
 *
 * Also collects every `transform` node's raw config encountered along that
 * same path, in actual forward pipeline order (source-adjacent first) —
 * the BFS itself walks nearest-to-farthest from `nodeId` (i.e. backward,
 * furthest-from-source first), so the collected list is reversed before
 * being returned. Consumed by NodeDrawer.tsx (via pushdown.ts's
 * transformOutputFields) to know what field *names* a destination's
 * mapping dropdown should offer when an Aggregate transform sits upstream
 * of it — same linear-chain assumption as runPreview.ts's findSourcePath.
 *
 * Schema layer Part 4: also surfaces the source node's own persisted
 * `entity` (namespace/name), parsed the same way NodeDrawer.tsx already
 * parses every node's raw config — needed by MappingEditor.tsx's contract
 * preview to look up the source entity's typed field list (not just the
 * flat field-name union useEntityFields already provides).
 */
export function findUpstreamSource(
  nodeId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): { connectionId?: string; manifestId?: string; entity?: EntityRef; transformConfigs: Record<string, unknown>[] } | undefined {
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];
  const transformConfigsBackward: Record<string, unknown>[] = [];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of edges) {
        if (edge.target !== id || visited.has(edge.source)) continue;
        visited.add(edge.source);
        const upstream = nodesById.get(edge.source);
        if (!upstream) continue;
        if (upstream.data.graphNodeType === 'source') {
          const parsed = parseNodeConfig('source', upstream.data.config);
          const entity = !parsed.unrecognized && parsed.type !== 'transform' ? parsed.value.entity : undefined;
          return {
            connectionId: upstream.data.connectionId,
            manifestId: upstream.data.manifestId,
            entity,
            transformConfigs: transformConfigsBackward.slice().reverse(),
          };
        }
        if (upstream.data.graphNodeType === 'transform') transformConfigsBackward.push(upstream.data.config);
        next.push(edge.source);
      }
    }
    frontier = next;
  }
  return undefined;
}
