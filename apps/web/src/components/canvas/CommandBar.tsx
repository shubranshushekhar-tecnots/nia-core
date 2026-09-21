'use client';

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { PlanProposeOutcome } from '@nia/schemas';
import type { Connection } from '@/lib/connections/types';
import { STAGE_LABEL, type LocalMessage } from '@/lib/chat/useChatSession';
import { proposePlan, CopilotApiError, type AppliedPlan } from '@/lib/api/copilotClient';
import { useCanvasStore } from '@/lib/canvas/store';
import {
  chatCitationChipStyle,
  chatCitationCopyBtnStyle,
  chatCitationExpandedMetaStyle,
  chatCitationExpandedSqlStyle,
  chatCitationExpandedStyle,
  chatCitationExpandedTitleStyle,
  chatCitationsRowStyle,
  chatConflictBannerStyle,
  chatErrorBannerStyle,
  chatMentionDotStyle,
  chatMentionDropdownStyle,
  chatMentionEmptyStyle,
  chatMentionHandleStyle,
  chatMentionRowStyle,
  chatMentionToolStyle,
  chatMessageTextStyle,
  chatMessageWrapStyle,
  chatSlashMenuDropdownStyle,
  chatSlashMenuHintStyle,
  chatSlashMenuLabelStyle,
  chatSlashMenuRowStyle,
  chatStatusDotStyle,
  chatStatusRowStyle,
  chatUnfaithfulNoteStyle,
} from '@/components/app/styles';
import {
  appliedPlanErrorStyle,
  appliedPlanRevertBtnStyle,
  appliedPlanRevertedTagStyle,
  appliedPlanRowStyle,
  appliedPlanSummaryStyle,
  appliedPlansSectionStyle,
  appliedPlansTitleStyle,
} from './styles';

/**
 * "Ask or command…" chat surface for the canvas (Phase 5 Session 4) — reuses
 * the same useChatSession pipeline /app/chat's ChatClient.tsx drives, but
 * takes a merged multi-connection scope (selection ∪ @-pins, falling back to
 * every connection wired into the canvas) instead of a single selection.
 *
 * Restyled (Task 2, decision 1) from a floating bottom-center bar into the
 * live-chat portion of CopilotSidebar.tsx's docked 344px right panel — this
 * component keeps its exact prior behavior/props (thread, @-mentions, scope
 * chips, send/retry/reset) and is now a vertical flex column that fills the
 * sidebar's remaining height below the panel's header/mock section, instead
 * of an absolutely-positioned overlay sized against ChecksDock's height.
 *
 * Phase 7 Session 3 — `/`-prefixed input now dispatches to Copilot's
 * plan-propose flow (POST /workflows/:id/plan via copilotClient.ts's
 * proposePlan()) instead of being blocked. This is a plain request/response
 * call, not SSE (see copilotClient.ts's header comment on why) — sending
 * disables the input until the single response comes back. A successful
 * "ok" outcome calls the canvas store's setGhostPlan() so FlowCanvas.tsx's
 * ghost overlay picks it up; every other outcome (clarify/refused/
 * no-connection/error) renders as an assistant-style bubble in this same
 * thread. Plan turns are deliberately NOT persisted (no insertUserMessage
 * call anywhere in this path, mirroring copilotPropose.ts's service-layer
 * decision) — they live only in this component's own `planMessages` state,
 * merged into the thread display alongside the real (persisted) chat
 * `messages` prop, and reset on New chat same as everything else.
 */

/**
 * Display-only fix: `m.content` streams down as a plain string, so literal
 * `**text**` markers (Copilot/answer-gen output uses them for emphasis)
 * showed up as raw asterisks instead of bold. Splits on the marker and
 * wraps matches in <strong> — no change to the underlying message data.
 */
function renderInlineBold(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part,
  );
}

function outcomeToLocalMessage(outcome: PlanProposeOutcome): LocalMessage {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  switch (outcome.status) {
    case 'ok':
      return { id, role: 'assistant', content: `Proposed: ${outcome.plan.summary}`, citations: [], status: 'complete', createdAt };
    case 'clarify':
      return { id, role: 'assistant', content: outcome.question, citations: [], status: 'complete', createdAt };
    case 'no-connection':
      return { id, role: 'assistant', content: outcome.message, citations: [], status: 'error', createdAt };
    case 'refused':
      return { id, role: 'assistant', content: outcome.message, citations: [], status: 'refused', createdAt };
    case 'error':
      return { id, role: 'assistant', content: outcome.error, citations: [], status: 'error', createdAt };
  }
}

// Static example prompts for the "/" suggestion menu. Copilot's
// plan-propose flow has no distinct command sub-types (every "/" message
// is free-text NL routed through the same proposePlan() call) — these are
// just starting points a user can pick and then edit before sending.
const SLASH_SUGGESTIONS: string[] = [
  'Add a source node reading a table from my connection.',
  'Add a filter on a column.',
  'Group and aggregate by a column.',
  'Add a computed field.',
  'Connect two nodes together.',
  'Add a destination node writing to a table.',
];

const wrapStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
};

const chipsRowStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 6,
  padding: '10px 16px',
  borderBottom: '1px solid var(--panel-line)',
};

function scopeChipStyle(): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 24,
    boxSizing: 'border-box',
    padding: '0 10px',
    borderRadius: 999,
    fontSize: 11.5,
    fontFamily: 'var(--font-data)',
    color: 'var(--acc)',
    background: 'var(--surface)',
    border: '1px solid var(--acc-bd)',
    boxShadow: 'var(--amb)',
  };
}

const scopeChipRemoveStyle: CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 12,
  lineHeight: 1,
  color: 'var(--ink4)',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
};

const scopeFallbackTextStyle: CSSProperties = {
  fontSize: 11.5,
  color: 'var(--ink4)',
  padding: '0 4px',
};

const barPositionStyle: CSSProperties = { position: 'relative', flex: 'none', padding: '10px 16px' };

const barShellStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  height: 52,
  boxSizing: 'border-box',
  padding: '0 10px',
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  boxShadow: 'var(--drop)',
};

const iconBtnStyle: CSSProperties = {
  flex: 'none',
  width: 30,
  height: 30,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 8,
  fontSize: 16,
  background: 'transparent',
  border: 'none',
  color: 'var(--ink4)',
  cursor: 'pointer',
};

const disabledIconBtnStyle: CSSProperties = {
  ...iconBtnStyle,
  cursor: 'not-allowed',
  opacity: 0.5,
};

const barInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: '100%',
  fontFamily: 'inherit',
  fontSize: 13.5,
  color: 'var(--ink)',
  background: 'transparent',
  border: 'none',
  outline: 'none',
};

function barSendBtnStyle(disabled: boolean): CSSProperties {
  return {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 32,
    boxSizing: 'border-box',
    padding: '0 14px',
    fontFamily: 'inherit',
    fontSize: 12.5,
    fontWeight: 600,
    borderRadius: 9,
    border: 'none',
    background: disabled ? 'var(--surface2)' : 'var(--acc)',
    color: disabled ? 'var(--ink4)' : 'var(--onacc)',
    cursor: disabled ? 'default' : 'pointer',
  };
}

const commandHintStyle: CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 8,
  marginTop: 6,
  fontSize: 11.5,
  color: 'var(--ink4)',
  background: 'var(--surface2)',
  border: '1px solid var(--line2)',
  borderRadius: 999,
  padding: '4px 10px',
};

const threadStyle: CSSProperties = {
  boxSizing: 'border-box',
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: '16px 18px',
};

const threadHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const threadTitleStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--ink4)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
};

const threadActionsStyle: CSSProperties = { display: 'flex', gap: 12 };

const threadActionBtnStyle: CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--acc)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  padding: 0,
};

export default function CommandBar({
  workflowId,
  connections,
  wiredConnectionIds,
  selectedConnectionId,
  messages,
  streamStage,
  sending,
  transportError,
  send,
  retry,
  resetConversation,
  appliedPlans,
  onRevertPlan,
  revertingPlanId,
  revertError,
}: {
  workflowId: string;
  connections: Connection[];
  /** Every connectionId currently wired into the canvas (source + destination nodes), deduped. */
  wiredConnectionIds: string[];
  /** The canvas's currently selected node's connectionId, if it has one. */
  selectedConnectionId: string | null;
  messages: LocalMessage[];
  streamStage: string | null;
  sending: boolean;
  transportError: boolean;
  send: (connectionIds: string[], message: string) => Promise<void>;
  retry: () => void;
  resetConversation: () => void;
  /** Phase 12 — previously-applied Copilot diffs, for the "Applied changes" Revert list. */
  appliedPlans: AppliedPlan[];
  onRevertPlan: (planId: string) => void;
  revertingPlanId: string | null;
  revertError: { planId: string; message: string; conflicts?: string[] } | null;
}) {
  const setGhostPlan = useCanvasStore((s) => s.setGhostPlan);
  const clearGhost = useCanvasStore((s) => s.clearGhost);
  const [draft, setDraft] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [planMessages, setPlanMessages] = useState<LocalMessage[]>([]);
  const [planPending, setPlanPending] = useState(false);
  const [planConversationId, setPlanConversationId] = useState<string | undefined>(undefined);
  const [threadOpen, setThreadOpen] = useState(messages.length > 0);
  const [expandedCitation, setExpandedCitation] = useState<string | null>(null);

  // Merges real (persisted) chat messages with local-only plan turns into
  // one chronological thread — see this file's header comment on why plan
  // turns aren't persisted.
  const allMessages = useMemo(
    () => [...messages, ...planMessages].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [messages, planMessages],
  );

  // Scope-precedence rule: dedupe(selectedNode's connection, ...pins). Empty
  // → fall back to every connection wired into the canvas.
  const scopeConnectionIds = useMemo(() => {
    const ids = [selectedConnectionId, ...pinnedIds].filter((x): x is string => !!x);
    return Array.from(new Set(ids));
  }, [selectedConnectionId, pinnedIds]);

  const effectiveScope = scopeConnectionIds.length > 0 ? scopeConnectionIds : wiredConnectionIds;

  // @-mention popover only lists connections actually wired into this
  // canvas — this is workflow-scoped, not the full org connection list.
  const mentionable = useMemo(
    () => connections.filter((c) => wiredConnectionIds.includes(c.id)),
    [connections, wiredConnectionIds],
  );

  const isCommand = draft.trim().startsWith('/');
  const sendDisabled = !draft.trim() || sending || planPending || (!isCommand && effectiveScope.length === 0);

  function pickMention(connection: Connection) {
    setDraft((d) => d.replace(/@[^\s]*$/, ''));
    setPinnedIds((ids) => (ids.includes(connection.id) ? ids : [...ids, connection.id]));
    setMentionOpen(false);
  }

  function removePin(id: string) {
    setPinnedIds((ids) => ids.filter((x) => x !== id));
  }

  function pickSlashSuggestion(text: string) {
    setDraft('/' + text);
    setSlashMenuOpen(false);
  }

  function handlePlusClick() {
    setDraft((d) => {
      const next = d.trimStart().startsWith('/') ? d : '/' + d;
      setSlashMenuOpen(/^\/[^\s]*$/.test(next.trimStart()));
      return next;
    });
  }

  async function handlePlanCommand(trimmed: string) {
    const message = trimmed.replace(/^\/+\s*/, '');
    if (!message) return;
    const userMsg: LocalMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      citations: [],
      status: 'complete',
      createdAt: new Date().toISOString(),
    };
    setPlanMessages((prev) => [...prev, userMsg]);
    setDraft('');
    setMentionOpen(false);
    setSlashMenuOpen(false);
    setThreadOpen(true);
    setPlanPending(true);
    try {
      const { conversationId, outcome } = await proposePlan(workflowId, { message, conversationId: planConversationId });
      setPlanConversationId(conversationId);
      setPlanMessages((prev) => [...prev, outcomeToLocalMessage(outcome)]);
      if (outcome.status === 'ok') setGhostPlan(outcome.plan);
    } catch (err) {
      const text = err instanceof CopilotApiError ? err.message : 'Copilot is unavailable right now.';
      setPlanMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: text, citations: [], status: 'error', createdAt: new Date().toISOString() },
      ]);
    } finally {
      setPlanPending(false);
    }
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed || sending || planPending) return;
    if (trimmed.startsWith('/')) {
      await handlePlanCommand(trimmed);
      return;
    }
    if (effectiveScope.length === 0) return;
    setDraft('');
    setMentionOpen(false);
    setThreadOpen(true);
    await send(effectiveScope, trimmed);
  }

  function handleNewChat() {
    resetConversation();
    setPinnedIds([]);
    setThreadOpen(false);
    setPlanMessages([]);
    setPlanConversationId(undefined);
    clearGhost();
  }

  return (
    <div style={wrapStyle} data-testid="command-bar">
      {threadOpen && allMessages.length > 0 && (
        <div style={threadStyle} data-testid="command-bar-thread">
          <div style={threadHeaderStyle}>
            <span style={threadTitleStyle}>Thread</span>
            <div style={threadActionsStyle}>
              <button type="button" style={threadActionBtnStyle} onClick={handleNewChat}>
                New chat
              </button>
              <button type="button" style={threadActionBtnStyle} onClick={() => setThreadOpen(false)}>
                Dismiss
              </button>
            </div>
          </div>
          {allMessages.map((m) => {
            const isUser = m.role === 'user';
            return (
              <div key={m.id} style={chatMessageWrapStyle(isUser)}>
                {m.status === 'error' || m.status === 'refused' ? (
                  <div style={chatErrorBannerStyle}>
                    <span aria-hidden>{'\u26A0'}</span>
                    <span>{renderInlineBold(m.content)}</span>
                  </div>
                ) : m.status === 'conflict' ? (
                  <div style={chatConflictBannerStyle}>{m.content}</div>
                ) : (
                  <>
                    <div style={chatMessageTextStyle(isUser)} data-testid="command-bar-message-text">
                      {m.content ? renderInlineBold(m.content) : m.status === 'streaming' ? '\u2026' : ''}
                    </div>
                    {m.faithful === false && (
                      <span style={chatUnfaithfulNoteStyle}>This answer may not be fully supported by the source data.</span>
                    )}
                    {m.citations.length > 0 && (
                      <div style={chatCitationsRowStyle}>
                        {m.citations.map((c, i) => {
                          const key = `${m.id}:${i}`;
                          const expanded = expandedCitation === key;
                          const conn = connections.find((cc) => cc.id === c.connectionId);
                          return (
                            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <button
                                type="button"
                                style={chatCitationChipStyle(expanded)}
                                onClick={() => setExpandedCitation((cur) => (cur === key ? null : key))}
                              >
                                {(conn?.handle ?? c.connectionId) + ' · ' + c.rowCount + ' rows' + (c.truncated ? ' (truncated)' : '')}
                              </button>
                              {expanded && (
                                <div style={chatCitationExpandedStyle}>
                                  <span style={chatCitationExpandedTitleStyle}>{conn?.handle ?? c.connectionId}</span>
                                  <pre style={chatCitationExpandedSqlStyle}>{c.executedQuery}</pre>
                                  <span style={chatCitationExpandedMetaStyle}>
                                    {c.rowCount} rows{c.truncated ? ' · truncated' : ''}
                                  </span>
                                  <button
                                    type="button"
                                    style={chatCitationCopyBtnStyle}
                                    onClick={() => navigator.clipboard.writeText(c.executedQuery)}
                                  >
                                    Copy query
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {streamStage && (
            <div style={chatStatusRowStyle}>
              <span style={chatStatusDotStyle} />
              <span>{STAGE_LABEL[streamStage as keyof typeof STAGE_LABEL] ?? streamStage}</span>
            </div>
          )}
          {planPending && (
            <div style={chatStatusRowStyle} data-testid="command-bar-plan-pending">
              <span style={chatStatusDotStyle} />
              <span>Copilot is drafting a plan…</span>
            </div>
          )}
          {transportError && (
            <div style={chatErrorBannerStyle}>
              <span aria-hidden>{'\u26A0'}</span>
              <span>
                Connection to the answer stream dropped.{' '}
                <button type="button" style={chatCitationCopyBtnStyle} onClick={retry}>
                  Retry
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {appliedPlans.length > 0 && (
        <div style={appliedPlansSectionStyle} data-testid="applied-plans-section">
          <span style={appliedPlansTitleStyle}>Applied changes</span>
          {appliedPlans.map((plan) => {
            const reverted = plan.revertedAt !== null;
            const err = revertError?.planId === plan.id ? revertError : null;
            return (
              <div key={plan.id} data-testid="applied-plan-row">
                <div style={appliedPlanRowStyle}>
                  <span style={appliedPlanSummaryStyle} title={plan.summary}>
                    {plan.summary}
                  </span>
                  {reverted ? (
                    <span style={appliedPlanRevertedTagStyle}>Reverted</span>
                  ) : (
                    <button
                      type="button"
                      style={appliedPlanRevertBtnStyle}
                      onClick={() => onRevertPlan(plan.id)}
                      disabled={revertingPlanId === plan.id}
                      data-testid="applied-plan-revert"
                    >
                      {revertingPlanId === plan.id ? 'Reverting…' : 'Revert'}
                    </button>
                  )}
                </div>
                {err && (
                  <div style={appliedPlanErrorStyle} data-testid="applied-plan-error">
                    {err.message}
                    {err.conflicts && err.conflicts.length > 0 && `: ${err.conflicts.join(', ')}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {scopeConnectionIds.length > 0 ? (
        <div style={chipsRowStyle} data-testid="command-bar-scope">
          {scopeConnectionIds.map((id) => {
            const conn = connections.find((c) => c.id === id);
            const removable = id !== selectedConnectionId && pinnedIds.includes(id);
            return (
              <span key={id} style={scopeChipStyle()} data-testid="command-bar-scope-chip">
                {conn?.handle ?? id}
                {removable && (
                  <button
                    type="button"
                    style={scopeChipRemoveStyle}
                    onClick={() => removePin(id)}
                    aria-label={`Remove ${conn?.handle ?? id} from scope`}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      ) : (
        <div style={chipsRowStyle} data-testid="command-bar-scope">
          <span style={scopeFallbackTextStyle}>
            Scope: canvas ({wiredConnectionIds.length} connection{wiredConnectionIds.length === 1 ? '' : 's'})
          </span>
        </div>
      )}

      <div style={barPositionStyle}>
        {slashMenuOpen && (
          <div style={{ ...chatSlashMenuDropdownStyle, left: 0, right: 0 }} data-testid="command-bar-slash-menu">
            {SLASH_SUGGESTIONS.map((s) => (
              <SlashMenuRow key={s} text={s} onPick={() => pickSlashSuggestion(s)} />
            ))}
          </div>
        )}

        {mentionOpen && (
          <div style={{ ...chatMentionDropdownStyle, left: 0, right: 0 }} data-testid="command-bar-mention-dropdown">
            {mentionable.length === 0 ? (
              <div style={chatMentionEmptyStyle}>No connections wired into this canvas yet.</div>
            ) : (
              mentionable.map((c) => <MentionRow key={c.id} connection={c} onPick={() => pickMention(c)} />)
            )}
          </div>
        )}

        <div style={barShellStyle}>
          <button
            type="button"
            style={iconBtnStyle}
            title="Ask Copilot to propose a workflow change"
            onClick={handlePlusClick}
          >
            +
          </button>
          <input
            style={barInputStyle}
            placeholder="Ask or command… (@ to mention a node, / for actions)"
            value={draft}
            data-testid="command-bar-input"
            onChange={(e) => {
              const val = e.target.value;
              setDraft(val);
              const isSlashToken = /^\/[^\s]*$/.test(val.trimStart());
              setSlashMenuOpen(isSlashToken);
              setMentionOpen(!isSlashToken && val.includes('@'));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSend();
            }}
          />
          <button type="button" style={disabledIconBtnStyle} disabled title="Voice input isn't available yet">
            🎤
          </button>
          <button
            type="button"
            style={barSendBtnStyle(sendDisabled)}
            disabled={sendDisabled}
            onClick={handleSend}
            data-testid="command-bar-send"
          >
            {planPending ? 'Working…' : 'Send'}
          </button>
        </div>

        {isCommand && !planPending && (
          <div style={commandHintStyle} data-testid="command-bar-hint">
            Copilot will propose a plan — review the ghost preview on the canvas before applying.
          </div>
        )}
      </div>
    </div>
  );
}

function SlashMenuRow({ text, onPick }: { text: string; onPick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      style={chatSlashMenuRowStyle(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      <span style={chatSlashMenuLabelStyle}>{text}</span>
      <span style={chatSlashMenuHintStyle}>Copilot</span>
    </button>
  );
}

function MentionRow({ connection, onPick }: { connection: Connection; onPick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const dotColor = connection.lastTestStatus === 'ok' ? 'var(--ok)' : connection.lastTestStatus === 'error' ? 'var(--bad)' : 'var(--text-4)';
  return (
    <button
      type="button"
      style={chatMentionRowStyle(hovered)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      <span style={{ ...chatMentionDotStyle, background: dotColor }} />
      <span style={chatMentionHandleStyle}>{connection.handle}</span>
      <span style={chatMentionToolStyle}>{connection.connectorId}</span>
    </button>
  );
}
