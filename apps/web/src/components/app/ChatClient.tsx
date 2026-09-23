'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connection } from '@/lib/connections/types';
import type { ChatMessage, Conversation } from '@/lib/api/chatServer';
import { STAGE_LABEL, useChatSession } from '@/lib/chat/useChatSession';
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
  const [historyList, setHistoryList] = useState<Conversation[]>(conversations);
  const [draft, setDraft] = useState('');
  const [composerFocus, setComposerFocus] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(
    connections.length === 1 ? connections[0]?.id ?? null : null,
  );
  const [expandedCitation, setExpandedCitation] = useState<string | null>(null);

  const listEndRef = useRef<HTMLDivElement | null>(null);

  const { messages, activeConversationId, streamStage, sending, transportError, send, retry } = useChatSession({
    conversationId,
    initialMessages,
    onConversationCreated: (resolvedId, firstMessage) => {
      window.history.replaceState(null, '', `/app/chat/${resolvedId}`);
      setHistoryList((h) => [
        { id: resolvedId, title: firstMessage.slice(0, 60), createdBy: '', workflowId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ...h,
      ]);
    },
  });

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamStage]);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.id === selectedConnectionId) ?? null,
    [connections, selectedConnectionId],
  );

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
    setDraft('');
    setMentionOpen(false);
    await send([selectedConnectionId], trimmed);
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
