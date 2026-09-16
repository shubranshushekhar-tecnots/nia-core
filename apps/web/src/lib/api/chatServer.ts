import { cookies } from 'next/headers';
import { ApiError } from './server';

const API_URL = process.env.NEXT_PUBLIC_API_URL!;

export type Conversation = {
  id: string;
  title: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatCitation = { connectionId: string; executedQuery: string; rowCount: number; truncated: boolean };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: ChatCitation[];
  status: 'complete' | 'refused' | 'error' | 'conflict';
  createdAt: string;
};

/**
 * Server Component equivalent of lib/api/server.ts's apiFetchServer, but for
 * apps/api's chat routes specifically — those run requireCookieAuth (not
 * requireAuth), because the browser reaches them cookie-only through the
 * /api/backend/:path* rewrite (see next.config.mjs) and EventSource can't
 * attach a bearer header. A Server Component has no bearer token to give
 * them either, so this forwards the incoming request's own cookies
 * (next/headers) instead of minting an Authorization header — same
 * httpOnly Supabase session cookies requireCookieAuth already knows how to
 * read via createCookieScopedSupabaseClient.
 */
async function apiFetchServerCookie<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const res = await fetch(`${API_URL}${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
      body?.error?.details,
    );
  }

  return res.json() as Promise<T>;
}

export async function getConversations(): Promise<Conversation[]> {
  return apiFetchServerCookie<Conversation[]>('/chat/conversations');
}

export async function getConversationMessages(id: string): Promise<ChatMessage[]> {
  return apiFetchServerCookie<ChatMessage[]>(`/chat/conversations/${id}/messages`);
}
