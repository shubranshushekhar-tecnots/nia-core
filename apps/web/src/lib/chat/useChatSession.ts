'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatCitation, ChatMessage } from '@/lib/api/chatServer';
import { ChatApiError, postChatMessage, streamChat } from '@/lib/api/chatClient';
import type { ChatStreamEvent } from '@nia/schemas';

/**
 * Shared chat SSE/event/retry mechanics, extracted out of ChatClient.tsx
 * (Phase 5 Session 4) so both the /app/chat single-select UI and the
 * canvas's CommandBar.tsx (which sends a merged multi-connection scope) can
 * drive the exact same pipeline without duplicating it. `connectionIds` is
 * taken at send()-time (not at hook-construction time) since the two
 * callers derive their scope completely differently.
 */

export type LocalStatus = 'streaming' | 'complete' | 'refused' | 'error' | 'conflict';

export type LocalMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: ChatCitation[];
  status: LocalStatus;
  faithful?: boolean;
  // Needed for the canvas Logs tab's newest-first merge with check runs
  // (apps/web/src/lib/canvas/activityFeed.ts) — otherwise unused by
  // ChatClient.tsx/CommandBar.tsx's own rendering, which is append-order.
  createdAt: string;
};

export const STAGE_LABEL: Record<string, string> = {
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
  return { id: m.id, role: m.role, content: m.content, citations: m.citations, status: m.status, createdAt: m.createdAt };
}

export function useChatSession({
  conversationId,
  initialMessages,
  workflowId,
  onConversationCreated,
}: {
  conversationId?: string;
  initialMessages: ChatMessage[];
  // Only ever consulted on the very first send of a brand-new conversation
  // (see send() below) — links it to the workflow it was asked from so
  // reopening the workflow can restore the thread.
  workflowId?: string;
  onConversationCreated?: (id: string, firstMessage: string) => void;
}) {
  const [messages, setMessages] = useState<LocalMessage[]>(() => initialMessages.map(toLocalMessage));
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>(conversationId);
  const [streamStage, setStreamStage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [transportError, setTransportError] = useState(false);

  const teardownRef = useRef<(() => void) | null>(null);
  const lastJobIdRef = useRef<string | null>(null);
  const activeAssistantIdRef = useRef<string | null>(null);
  // Highest seq seen on the current job's stream — undefined until the first
  // event arrives. Reset on every new send() (a fresh job has its own
  // independent seq space). Fed to retry()'s openStream() as afterSeq so a
  // manual reconnect resumes instead of re-replaying from the start.
  const lastSeqRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => teardownRef.current?.();
  }, []);

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

  async function send(connectionIds: string[], message: string) {
    const trimmed = message.trim();
    if (!trimmed || connectionIds.length === 0 || sending) return;

    setSending(true);
    setTransportError(false);

    const userMsg: LocalMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      citations: [],
      status: 'complete',
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, userMsg]);

    try {
      const { jobId, conversationId: resolvedId } = await postChatMessage({
        conversationId: activeConversationId,
        message: trimmed,
        connectionIds,
        // Ignored server-side once a conversation already exists — only
        // matters on the very first send.
        workflowId: activeConversationId ? undefined : workflowId,
      });

      if (!activeConversationId) {
        setActiveConversationId(resolvedId);
        onConversationCreated?.(resolvedId, trimmed);
      }

      const assistantId = crypto.randomUUID();
      setMessages((m) => [
        ...m,
        { id: assistantId, role: 'assistant', content: '', citations: [], status: 'streaming', createdAt: new Date().toISOString() },
      ]);
      setStreamStage('rewriting');
      lastSeqRef.current = undefined; // fresh job — its own independent seq space
      openStream(jobId, assistantId);
    } catch (err) {
      setSending(false);
      setStreamStage(null);
      const errMessage = err instanceof ChatApiError ? err.message : 'Something went wrong sending your message.';
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: 'assistant', content: errMessage, citations: [], status: 'error', createdAt: new Date().toISOString() },
      ]);
    }
  }

  // Clears down to a fresh, conversation-less state client-side (CommandBar's
  // "New chat" affordance) — the next send() creates a brand-new conversation
  // server-side since no conversationId will be passed.
  function resetConversation() {
    teardownRef.current?.();
    teardownRef.current = null;
    setMessages([]);
    setActiveConversationId(undefined);
    setStreamStage(null);
    setSending(false);
    setTransportError(false);
    lastJobIdRef.current = null;
    activeAssistantIdRef.current = null;
    lastSeqRef.current = undefined;
  }

  return {
    messages,
    activeConversationId,
    streamStage,
    sending,
    transportError,
    send,
    retry,
    resetConversation,
  };
}
