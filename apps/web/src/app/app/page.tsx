import { requireUser } from '@/lib/auth/session';
import { getDashboardStats, getRecentRuns, getSidebarProjects } from '@/lib/api/dashboardServer';
import { getPlanUsage } from '@/lib/billing/plan';
import { greetingForHour } from '@/lib/time';
import AppShell from '@/components/app/AppShell';
import Sidebar from '@/components/app/Sidebar';
import TopBar from '@/components/app/TopBar';
import HomeContent from '@/components/app/HomeContent';
import { mainColStyle } from '@/components/app/styles';

export default async function AppHomePage() {
  const user = await requireUser();
  const orgId = user.org?.id ?? null;

  const [projects, stats, recentRuns] = await Promise.all([
    getSidebarProjects(),
    getDashboardStats(),
    getRecentRuns(50),
  ]);

  const plan = getPlanUsage(stats);
  const greeting = greetingForHour(new Date().getHours());

  return (
    <AppShell
      topBar={
        <TopBar
          orgName={user.org?.name ?? null}
          email={user.email}
          userId={user.userId}
          fullName={user.fullName}
          orgs={user.orgs}
          activeOrgId={user.org?.id ?? null}
        />
      }
    >
      <Sidebar orgId={orgId} role={user.role} projects={projects} />
      <div style={mainColStyle}>
        <HomeContent
          greeting={greeting}
          fullName={user.fullName}
          userId={user.userId}
          orgName={user.org?.name ?? null}
          recentRuns={recentRuns}
          plan={plan}
          stats={stats}
        />
      </div>
    </AppShell>
  );
}
