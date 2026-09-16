import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getSidebarProjects } from '@/lib/api/dashboardServer';
import { getConnections } from '@/lib/api/connectionsServer';
import { getConversations } from '@/lib/api/chatServer';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import ChatClient from '@/components/app/ChatClient';
import { mainColStyle } from '@/components/app/styles';

// Dev-only: the standalone /app/chat page was superseded by the builder's
// floating command bar (Phase 5 Session 4) and is no longer shipped nav UI.
// Kept working in non-production builds as a harness for the underlying
// scope-agnostic chat components/pipeline Session 4 reuses; unreachable in
// production until/unless a real product decision re-ships it.
export default async function ChatPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  const user = await requireUser();
  const orgId = user.org?.id ?? null;
  const [projects, connections, conversations] = await Promise.all([
    getSidebarProjects(),
    getConnections(),
    getConversations(),
  ]);

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <ChatClient
          currentUserId={user.userId}
          connections={connections}
          conversations={conversations}
          initialMessages={[]}
        />
      </div>
    </AppShell>
  );
}
