'use client';

import { forwardRef } from 'react';
import type { Ref } from 'react';
import type { NodeKind, NodeStatus, PipelineNode } from './config';
import { TONE_VAR } from './config';

type Props = {
  node: PipelineNode;
  status: NodeStatus;
  progress: number;
  rowsLabel?: string;
  isFollowed: boolean;
  isPinned: boolean;
  onSelect: (id: NodeKind) => void;
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  ready: 'Waiting',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
};

function NodeCardImpl({ node, status, progress, rowsLabel, isFollowed, isPinned, onSelect }: Props, ref: Ref<HTMLButtonElement>) {
  const tone = TONE_VAR[node.tone];
  const statusLine = rowsLabel && status !== 'ready' ? `${STATUS_LABEL[status]} · ${rowsLabel} rows` : STATUS_LABEL[status];

  return (
    <button
      ref={ref}
      type="button"
      className="wr-node"
      data-status={status}
      data-followed={isFollowed}
      data-pinned={isPinned}
      data-muted={node.tone === 'muted'}
      style={{ gridArea: node.area, ['--wr-tone' as string]: tone }}
      title={`${node.subtitle}: ${node.name}`}
      aria-pressed={isPinned}
      onClick={() => onSelect(node.id)}
    >
      <span className="wr-node-top">
        <span className="wr-node-chip" aria-hidden="true">{node.mono}</span>
        <span className="wr-node-type">{node.subtitle}</span>
      </span>
      <span className="wr-node-name">{node.name}</span>
      <span className="wr-node-status">
        <span className="wr-node-dot" aria-hidden="true" />
        {statusLine}
      </span>
      <span className="wr-node-bar-track" aria-hidden="true">
        <span className="wr-node-bar-fill" style={{ width: `${progress * 100}%` }} />
      </span>
    </button>
  );
}

const NodeCard = forwardRef(NodeCardImpl);
export default NodeCard;
