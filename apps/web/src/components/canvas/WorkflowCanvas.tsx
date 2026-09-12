'use client';

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { renameWorkflow, updateWorkflowDefinition } from '@/lib/dashboard/actions';
import type { CanvasNode, CanvasWire, WorkflowDetail } from '@/lib/dashboard/types';
import { brandTextStyle, breadcrumbSepStyle } from '@/components/app/styles';
import NodeCard from './NodeCard';
import Wire from './Wire';
import NodePicker, { type NodeCatalogEntry } from './NodePicker';
import NodeConfigPanel from './NodeConfigPanel';

let idCounter = 0;
function genId() {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter}`;
}

// Full-screen canvas surface — no AppShell/Sidebar, matches the design's
// builder screen being its own standalone view with just a top bar. Breadcrumb
// reuses the exact same brandTextStyle/breadcrumbSepStyle primitives as the
// rest of the app (Project name / Canvas name), not new typography.
export default function WorkflowCanvas({ workflow }: { workflow: WorkflowDetail }) {
  const [nodes, setNodes] = useState<CanvasNode[]>(workflow.definition.nodes);
  const [wires, setWires] = useState<CanvasWire[]>(workflow.definition.wires);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [title, setTitle] = useState(workflow.name);

  const draggingRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRun = useRef(true);

  // Debounced persistence — 800ms after the last nodes/wires change. Skips
  // the initial mount (definition already matches what's loaded).
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(() => {
      updateWorkflowDefinition(workflow.id, { nodes, wires }).then((result) => {
        setSaveState(result.success ? 'saved' : 'idle');
      });
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, wires]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const drag = draggingRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      setNodes((prev) => prev.map((n) => (n.id === drag.id ? { ...n, x: drag.origX + dx, y: drag.origY + dy } : n)));
    }
    function onUp() {
      draggingRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  function handlePointerDown(id: string, e: ReactPointerEvent) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    draggingRef.current = { id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y };
    setSelectedNodeId(id);
  }

  function handlePortClick(nodeId: string) {
    if (!connectingFrom) {
      setConnectingFrom(nodeId);
      return;
    }
    if (connectingFrom === nodeId) {
      setConnectingFrom(null);
      return;
    }
    setWires((prev) =>
      prev.some(([a, b]) => a === connectingFrom && b === nodeId) ? prev : [...prev, [connectingFrom, nodeId]],
    );
    setConnectingFrom(null);
  }

  function handleInsertNode(entry: NodeCatalogEntry) {
    const id = genId();
    setNodes((prev) => [
      ...prev,
      { id, kind: entry.kind, tool: entry.tool, handle: entry.label, x: 160 + prev.length * 40, y: 120 + prev.length * 30, config: {} },
    ]);
    setShowPicker(false);
    setSelectedNodeId(id);
  }

  function handleDeleteNode(id: string) {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setWires((prev) => prev.filter(([a, b]) => a !== id && b !== id));
    if (selectedNodeId === id) setSelectedNodeId(null);
  }

  function handleDuplicateNode(id: string) {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const newId = genId();
    setNodes((prev) => [...prev, { ...node, id: newId, x: node.x + 32, y: node.y + 32 }]);
    setSelectedNodeId(newId);
  }

  function handleDeleteWire(index: number) {
    setWires((prev) => prev.filter((_, i) => i !== index));
  }

  function handleConfigChange(id: string, config: Record<string, string>) {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, config } : n)));
  }

  async function handleTitleBlur(value: string) {
    setRenamingTitle(false);
    if (!value.trim() || value === title) return;
    const fd = new FormData();
    fd.set('name', value);
    const result = await renameWorkflow(workflow.id, null, fd);
    if (!result?.error) setTitle(value);
  }

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--canvas)', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          height: 56,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 16px',
          borderBottom: '1px solid var(--line2)',
          background: 'var(--surface)',
        }}
      >
        <Link href={`/app/projects/${workflow.project.id}`} style={{ ...brandTextStyle, textDecoration: 'none' }}>
          {'\u2190'} {workflow.project.name}
        </Link>
        <span style={breadcrumbSepStyle}>/</span>
        {renamingTitle ? (
          <input
            defaultValue={title}
            autoFocus
            onBlur={(e) => handleTitleBlur(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            style={{ ...brandTextStyle, border: 'none', borderBottom: '1px solid var(--line2)', background: 'transparent', outline: 'none' }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setRenamingTitle(true)}
            style={{ ...brandTextStyle, background: 'none', border: 'none', cursor: 'text', padding: 0 }}
          >
            {title}
          </button>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink3)' }}>
          {saveState === 'saving' ? 'Saving\u2026' : saveState === 'saved' ? 'Saved' : ''}
        </span>

        <button
          type="button"
          onClick={() => setShowPicker(true)}
          style={{ height: 32, padding: '0 14px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          + Add node
        </button>
      </div>

      <div
        style={{
          position: 'relative',
          flex: 1,
          overflow: 'auto',
          backgroundImage: 'radial-gradient(var(--dot) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
        onClick={() => {
          setSelectedNodeId(null);
          if (connectingFrom) setConnectingFrom(null);
        }}
      >
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {wires.map(([fromId, toId], i) => {
            const from = nodes.find((n) => n.id === fromId);
            const to = nodes.find((n) => n.id === toId);
            if (!from || !to) return null;
            return <Wire key={i} from={from} to={to} kindFrom={from.kind} kindTo={to.kind} onDelete={() => handleDeleteWire(i)} />;
          })}
        </svg>

        {nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            selected={node.id === selectedNodeId}
            connecting={connectingFrom === node.id}
            onPointerDown={(e) => handlePointerDown(node.id, e)}
            onSelect={() => setSelectedNodeId(node.id)}
            onPortClick={() => handlePortClick(node.id)}
            onDelete={() => handleDeleteNode(node.id)}
            onDuplicate={() => handleDuplicateNode(node.id)}
          />
        ))}

        {nodes.length === 0 && (
          <div style={{ position: 'absolute', top: '40%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
            <p style={{ fontSize: 13.5, color: 'var(--ink3)', marginBottom: 12 }}>This canvas is empty.</p>
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              style={{ height: 34, padding: '0 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              + Add your first node
            </button>
          </div>
        )}
      </div>

      {showPicker && <NodePicker onSelect={handleInsertNode} onClose={() => setShowPicker(false)} />}

      {selectedNode && (
        <NodeConfigPanel
          node={selectedNode}
          onChange={(config) => handleConfigChange(selectedNode.id, config)}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  );
}
