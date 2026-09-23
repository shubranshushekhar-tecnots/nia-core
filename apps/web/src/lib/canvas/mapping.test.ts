import { describe, it, expect } from "vitest";
import { GraphDoc } from "@nia/schemas";
import { CONNECTOR_MANIFESTS } from "@nia/schemas";
import type { Connection } from "@/lib/connections/types";
import { graphToFlow, flowToGraph, type MappingContext } from "./mapping.js";

function connection(id: string, connectorId: string): Connection {
  return {
    id,
    connectorId,
    handle: `${connectorId}-dev`,
    displayName: `${connectorId} dev`,
    ownerUserId: "u1",
    config: {},
    credVersion: 1,
    lastTestStatus: "ok",
    lastTestLatencyMs: 12,
    lastTestAt: new Date().toISOString(),
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const mysqlConnId = "11111111-1111-4111-8111-111111111111";
const baseCtx: MappingContext = {
  manifests: CONNECTOR_MANIFESTS,
  connectionsById: new Map([[mysqlConnId, connection(mysqlConnId, "mysql")]]),
};

describe("graphToFlow / flowToGraph round trip", () => {
  it("round-trips a doc with all three node kinds and a manifest+connection-backed node, byte-identical incl. positions", () => {
    const doc = GraphDoc.parse({
      nodes: [
        {
          id: "n1",
          type: "source",
          connectionId: mysqlConnId,
          manifestId: "mysql",
          position: { x: 48.5, y: 60 },
          config: { table: "orders" },
        },
        {
          id: "n2",
          type: "transform",
          position: { x: 428, y: 60 },
          config: {},
        },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", sourceHandle: "out", targetHandle: "in" }],
    });

    const { nodes, edges } = graphToFlow(doc, baseCtx);
    expect(flowToGraph(nodes, edges)).toEqual(doc);
  });

  it("round-trips an empty doc", () => {
    const doc = GraphDoc.parse({});
    const { nodes, edges } = graphToFlow(doc, baseCtx);
    expect(flowToGraph(nodes, edges)).toEqual(doc);
  });

  it("uses the React Flow node's live position, not the stale source position, after a simulated drag", () => {
    const doc = GraphDoc.parse({
      nodes: [{ id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    });
    const { nodes, edges } = graphToFlow(doc, baseCtx);
    const dragged = nodes.map((n) => (n.id === "n1" ? { ...n, position: { x: 240, y: 96 } } : n));

    const result = flowToGraph(dragged, edges);

    expect(result.nodes[0]!.position).toEqual({ x: 240, y: 96 });
  });

  it("threads parkedLegacyTriggers through untouched (never derived from nodes/edges)", () => {
    const doc = GraphDoc.parse({
      nodes: [],
      edges: [],
      parkedLegacyTriggers: [{ id: "old-trigger-1", kind: "trigger", tool: "webhook" }],
    });
    const { nodes, edges } = graphToFlow(doc, baseCtx);
    const result = flowToGraph(nodes, edges, doc.parkedLegacyTriggers);
    expect(result).toEqual(doc);
  });

  it("mapped node type strings match GraphNode.type exactly, for React Flow's nodeTypes dispatch", () => {
    const doc = GraphDoc.parse({
      nodes: [
        { id: "n1", type: "source", position: { x: 0, y: 0 }, config: {} },
        { id: "n2", type: "transform", position: { x: 0, y: 0 }, config: {} },
        { id: "n3", type: "destination", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    });
    const { nodes } = graphToFlow(doc, baseCtx);
    expect(nodes.map((n) => n.type)).toEqual(["source", "transform", "destination"]);
  });
});

describe("resolution + write-lock", () => {
  it("marks a node with an unknown manifestId as unresolved, with a descriptive reason, and does not crash", () => {
    const doc = GraphDoc.parse({
      nodes: [
        {
          id: "n1",
          type: "source",
          manifestId: "not-a-real-connector",
          position: { x: 0, y: 0 },
          config: {},
        },
      ],
      edges: [],
    });
    const { nodes } = graphToFlow(doc, baseCtx);
    expect(nodes[0]!.data.resolved).toBe(false);
    expect(nodes[0]!.data.unknownReason).toMatch(/not-a-real-connector/);
  });

  it("marks a node whose connectionId isn't in connectionsById as unresolved", () => {
    const doc = GraphDoc.parse({
      nodes: [
        {
          id: "n1",
          type: "source",
          manifestId: "mysql",
          connectionId: "99999999-9999-4999-8999-999999999999",
          position: { x: 0, y: 0 },
          config: {},
        },
      ],
      edges: [],
    });
    const { nodes } = graphToFlow(doc, baseCtx);
    expect(nodes[0]!.data.resolved).toBe(false);
    expect(nodes[0]!.data.unknownReason).toBeTruthy();
  });

  it("a bare node with neither manifestId nor connectionId is resolved (not-yet-wired transform)", () => {
    const doc = GraphDoc.parse({
      nodes: [{ id: "n1", type: "transform", position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    });
    const { nodes } = graphToFlow(doc, baseCtx);
    expect(nodes[0]!.data.resolved).toBe(true);
  });

  it("Item 6.2: connectionLabel appends host/database so same-named connections are distinguishable, and falls back to bare displayName when config has neither", () => {
    const withConfig: MappingContext = {
      manifests: CONNECTOR_MANIFESTS,
      connectionsById: new Map([[mysqlConnId, { ...connection(mysqlConnId, "mysql"), config: { host: "db.example.com", database: "sandbox" } }]]),
    };
    const doc = GraphDoc.parse({
      nodes: [
        { id: "n1", type: "source", manifestId: "mysql", connectionId: mysqlConnId, position: { x: 0, y: 0 }, config: {} },
        { id: "n2", type: "source", manifestId: "mysql", connectionId: mysqlConnId, position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    });
    const { nodes: withHostDb } = graphToFlow(doc, withConfig);
    expect(withHostDb[0]!.data.connectionLabel).toBe("mysql dev (db.example.com/sandbox)");

    const { nodes: withoutConfig } = graphToFlow(doc, baseCtx);
    expect(withoutConfig[0]!.data.connectionLabel).toBe("mysql dev");
  });

  it("writeLocked is false for read-only manifests (mysql/mongodb) but true for postgres/supabase, which both offer a write verb", () => {
    const doc = GraphDoc.parse({
      nodes: [
        { id: "n1", type: "source", manifestId: "mysql", position: { x: 0, y: 0 }, config: {} },
        { id: "n2", type: "source", manifestId: "mongodb", position: { x: 0, y: 0 }, config: {} },
        { id: "n3", type: "destination", manifestId: "supabase", position: { x: 0, y: 0 }, config: {} },
        { id: "n4", type: "destination", manifestId: "postgres", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    });
    const { nodes } = graphToFlow(doc, baseCtx);
    const byId = new Map(nodes.map((n) => [n.id, n.data.writeLocked]));
    expect(byId.get("n1")).toBe(false);
    expect(byId.get("n2")).toBe(false);
    expect(byId.get("n3")).toBe(true);
    expect(byId.get("n4")).toBe(true);
  });

  it("resolving an unresolved node's manifestId leaves the round-trip byte-identical (resolved/unknownReason/writeLocked are derived-only, not persisted)", () => {
    const doc = GraphDoc.parse({
      nodes: [
        { id: "n1", type: "source", manifestId: "not-a-real-connector", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    });
    const { nodes, edges } = graphToFlow(doc, baseCtx);
    expect(flowToGraph(nodes, edges)).toEqual(doc);
  });
});
