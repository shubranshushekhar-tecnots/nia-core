'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection } from '@/lib/connections/types';
import type { ChatCitation, ChatMessage, Conversation } from '@/lib/api/chatServer';
import { ChatApiError, postChatMessage, streamChat } from '@/lib/api/chatClient';
import type { ChatStreamEvent } from '@nia/schemas';
import {
  chatComposerInputStyle,
  chatComposerStyle,
  chatComposerWrapStyle,
  chatCitationChipStyle,
  chatCitationCopyBtnStyle,
  chatCitationExpandedMetaStyle,
  chatCitationExpandedSqlStyle,
  chatCitationExpandedStyle,
  chatCitationExpandedTitleStyle,
  chatCitationsRowStyle,
  chatConflictBannerStyle,
  chatEmptyStateStyle,
  chatEmptySubStyle,
  chatEmptyTitleStyle,
  chatErrorBannerStyle,
  chatHistoryHeaderStyle,
  chatHistoryListStyle,
  chatHistoryRowStyle,
  chatMainColStyle,
  chatMentionDotStyle,
  chatMentionDropdownStyle,
  chatMentionEmptyStyle,
  chatMentionHandleStyle,
  chatMentionRowStyle,
  chatMentionToolStyle,
  chatMessageListStyle,
  chatMessageTextStyle,
  chatMessageWrapStyle,
  chatNewBtnStyle,
  chatScopeEmptyStyle,
  chatScopeHeaderStyle,
  chatScopeHintStyle,
  chatScopeKnobStyle,
  chatScopeListStyle,
  chatScopeRailStyle,
  chatScopeRowStyle,
  chatScopeSwitchStyle,
  chatScopeTextColStyle,
  chatScopeToolStyle,
  chatScrollStyle,
  chatSendBtnStyle,
  chatStatusDotStyle,
  chatStatusRowStyle,
  chatUnfaithfulNoteStyle,
} from './styles';

type LocalStatus = 'streaming' | 'complete' | 'refused' | 'error' | 'conflict';

type LocalMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: ChatCitation[];
  status: LocalStatus;
  faithful?: boolean;
};

const STAGE_LABEL: Record<string, string> = {
  rewriting: 'Reading your question',
  planning_reduction: 'Planning',
  resolving: 'Resolving sources',
  introspecting: 'Inspecting schema',
  generating_query: 'Writing query',
  executing: 'Running query',
  generating_answer: 'Generating answer',
  checking_faithfulness: 'Checking answer',
};

function toLocalMessage(m: ChatMessage): LocalMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    citations: m.citations,
    status: m.status,
  };
}

export default function ChatClient({
  connections,
  conversations,
  conversationId,
  initialMessages,
}: {
  currentUserId: string;
  connections: Connection[];
  conversations: Conversation[];
  conversationId?: string;
  initialMessages: ChatMessage[];
}) {
  const [messages, setMessages] = useState<LocalMessage[]>(() => initialMessages.map(toLocalMessage));
  const [historyList, setHistoryList] = useState<Conversation[]>(conversations);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(conversationId);
  const [draft, setDraft] = useState('');
  const [composerFocus, setComposerFocus] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(
    connections.length === 1 ? connections[0]?.id ?? null : null,
  );
  const [expandedCitation, setExpandedCitation] = useState<string | null>(null);
  const [streamStage, setStreamStage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [transportError, setTransportError] = useState(false);

  const listEndRef = useRef<HTMLDivElement | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const lastJobIdRef = useRef<string | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  // Highest seq seen on the current job's stream — undefined until the first
  // event arrives. Reset on every new handleSend() (a fresh job has its own
  // independent seq space). Fed to retry()'s openStream() as afterSeq so a
  // manual reconnect resumes instead of re-replaying from the start.
  const lastSeqRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => teardownRef.current?.();
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamStage]);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId) ?? null,
    [connections, selectedConnectionId],
  );

  function applyEvent(assistantId: string, event: ChatStreamEvent) {
    if (event.type === 'status') {
      setStreamStage(event.stage);
      return;
    }
    if (event.type === 'token') {
      setStreamStage(null);
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, content: msg.content + event.text } : msg)));
      return;
    }
    if (event.type === 'citation') {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                citations: [
                  ...msg.citations,
                  {
                    connectionId: event.connectionId,
                    executedQuery: event.executedQuery,
                    rowCount: event.rowCount,
                    truncated: event.truncated,
                  },
                ],
              }
            : msg,
        ),
      );
      return;
    }
    setStreamStage(null);
    setSending(false);
    if (event.type === 'done') {
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, status: 'complete', faithful: event.faithful } : msg)));
    } else if (event.type === 'error') {
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, content: event.message, status: 'error' } : msg)));
    } else if (event.type === 'refused') {
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, content: event.message, status: 'refused' } : msg)));
    } else if (event.type === 'conflict') {
      setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, content: event.message, status: 'conflict' } : msg)));
    }
  }

  function openStream(jobId: string, assistantId: string, afterSeq?: number) {
    lastJobIdRef.current = jobId;
    activeAssistantIdRef.current = assistantId;
    teardownRef.current?.();
    teardownRef.current = streamChat(
      jobId,
      {
        onEvent: (event, seq) => {
          lastSeqRef.current = seq;
          applyEvent(assistantId, event);
        },
        onTransportError: () => setTransportError(true),
      },
      { afterSeq },
    );
  }

  function retry() {
    if (!lastJobIdRef.current || !activeAssistantIdRef.current) return;
    setTransportError(false);
    setSending(true);
    openStream(lastJobIdRef.current, activeAssistantIdRef.current, lastSeqRef.current);
  }

  function pickConnection(id: string) {
    setSelectedConnectionId((cur) => (cur === id ? null : id));
  }

  function pickMention(connection: Connection) {
    setDraft((d) => d.replace(/@[^\s]*$/, '') + connection.handle + ' ');
    setSelectedConnectionId(connection.id);
    setMentionOpen(false);
  }

  async function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed || !selectedConnectionId || sending) return;

    setSending(true);
    setTransportError(false);
    setDraft('');
    setMentionOpen(false);

    const userMsg: LocalMessage = { id: crypto.randomUUID(), role: 'user', content: trimmed, citations: [], status: 'complete' };
    setMessages((m) => [...m, userMsg]);

    try {
      const { jobId, conversationId: resolvedId } = await postChatMessage({
        conversationId: activeConversationId,
        message: trimmed,
        connectionIds: [selectedConnectionId],
      });

      if (!activeConversationId) {
        setActiveConversationId(resolvedId);
        window.history.replaceState(null, '', `/app/chat/${resolvedId}`);
        setHistoryList((h) => [
          { id: resolvedId, title: trimmed.slice(0, 60), createdBy: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          ...h,
        ]);
      }

      const assistantId = crypto.randomUUID();
      setMessages((m) => [...m, { id: assistantId, role: 'assistant', content: '', citations: [], status: 'streaming' }]);
      setStreamStage('rewriting');
      lastSeqRef.current = undefined; // fresh job — its own independent seq space
      openStream(jobId, assistantId);
    } catch (err) {
      setSending(false);
      setStreamStage(null);
      const message = err instanceof ChatApiError ? err.message : 'Something went wrong sending your message.';
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: 'assistant', content: message, citations: [], status: 'error' }]);
    }
  }

  const scopeHint = selectedConnection
    ? `In scope: ${selectedConnection.handle}`
    : 'No sources in scope — mention or toggle one on the right';

  return (
    <div style={chatScrollStyle}>
      <div style={chatHistoryListStyle}>
        <div style={chatHistoryHeaderStyle}>History</div>
        <a href="/app/chat" style={chatNewBtnStyle}>
          New chat
        </a>
        {historyList.map((c) => (
          <a key={c.id} href={`/app/chat/${c.id}`} style={chatHistoryRowStyle(c.id === activeConversationId)}>
            {c.title || 'Untitled conversation'}
          </a>
        ))}
      </div>

      <div style={chatMainColStyle}>
        {messages.length === 0 ? (
          <div style={chatEmptyStateStyle}>
            <span style={chatEmptyTitleStyle}>Ask Nia</span>
            <span style={chatEmptySubStyle}>
              Mention a connection with @ to scope your question to it, then ask anything about that data.
            </span>
          </div>
        ) : (
          <div style={chatMessageListStyle}>
            {messages.map((m) => {
              const isUser = m.role === 'user';
              return (
                <div key={m.id} style={chatMessageWrapStyle(isUser)}>
                  {m.status === 'error' || m.status === 'refused' ? (
                    <div style={chatErrorBannerStyle}>{m.content}</div>
                  ) : m.status === 'conflict' ? (
                    <div style={chatConflictBannerStyle}>{m.content}</div>
                  ) : (
                    <>
                      <div style={chatMessageTextStyle(isUser)}>
                        {m.content || (m.status === 'streaming' ? '\u2026' : '')}
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
            {transportError && (
              <div style={chatErrorBannerStyle}>
                Connection to the answer stream dropped.{' '}
                <button type="button" style={chatCitationCopyBtnStyle} onClick={retry}>
                  Retry
                </button>
              </div>
            )}
            <div ref={listEndRef} />
          </div>
        )}

        <div style={chatComposerWrapStyle}>
          {mentionOpen && (
            <div style={chatMentionDropdownStyle}>
              {connections.length === 0 ? (
                <div style={chatMentionEmptyStyle}>No connections yet — add one under Connections.</div>
              ) : (
                connections.map((c) => (
                  <MentionRow key={c.id} connection={c} onPick={() => pickMention(c)} />
                ))
              )}
            </div>
          )}
          <div style={chatComposerStyle(composerFocus)}>
            <input
              style={chatComposerInputStyle}
              placeholder="Ask about your data…"
              value={draft}
              onFocus={() => setComposerFocus(true)}
              onBlur={() => {
                setComposerFocus(false);
                setTimeout(() => setMentionOpen(false), 150);
              }}
              onChange={(e) => {
                const val = e.target.value;
                setDraft(val);
                setMentionOpen(val.includes('@'));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
            />
            <button
              type="button"
              style={chatSendBtnStyle(!draft.trim() || !selectedConnectionId || sending)}
              disabled={!draft.trim() || !selectedConnectionId || sending}
              onClick={handleSend}
            >
              Send
            </button>
          </div>
        </div>
      </div>

      <div style={chatScopeRailStyle}>
        <span style={chatScopeHeaderStyle}>Scope</span>
        <span style={chatScopeHintStyle}>{scopeHint}</span>
        {connections.length === 0 ? (
          <span style={chatScopeEmptyStyle}>No connections yet.</span>
        ) : (
          <div style={chatScopeListStyle}>
            {connections.map((c) => {
              const on = c.id === selectedConnectionId;
              return (
                <button key={c.id} type="button" style={chatScopeRowStyle} onClick={() => pickConnection(c.id)}>
                  <span style={chatScopeSwitchStyle(on)}>
                    <span style={chatScopeKnobStyle(on)} />
                  </span>
                  <span style={chatScopeTextColStyle}>
                    <span style={{ fontFamily: 'var(--font-data)', fontSize: 12.5, color: 'var(--text)' }}>{c.handle}</span>
                    <span style={chatScopeToolStyle}>{c.connectorId}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
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
