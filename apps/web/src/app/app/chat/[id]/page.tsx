import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import { getConnections } from '@/lib/api/connectionsServer';
import { getConversationMessages, getConversations } from '@/lib/api/chatServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ChatClient from '@/components/app/ChatClient';
import { mainColStyle } from '@/components/app/styles';

// Dev-only — see ../page.tsx's header comment.
export default async function ChatConversationPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  const { id } = await params;
  const user = await requireUser();
  const orgId = user.org?.id ?? null;
  // getConversationMessages 404s (via ApiError) for a foreign-org or
  // nonexistent id — RLS on `conversations`/`messages` (org-scoped select)
  // is the real boundary; the route's own getConversation()-first 404 check
  // (apps/api/src/routes/chat.ts) is what actually throws here, RLS would
  // otherwise just silently return an empty row.
  const [projects, connections, conversations, messages] = await Promise.all([
    getSidebarProjects(),
    getConnections(),
    getConversations(),
    getConversationMessages(id),
  ]);

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <ChatClient
          currentUserId={user.userId}
          connections={connections}
          conversations={conversations}
          conversationId={id}
          initialMessages={messages}
        />
      </div>
    </AppShell>
  );
}
