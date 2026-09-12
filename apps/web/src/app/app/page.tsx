import { requireUser } from '@/lib/auth/session';
import {
  getContinueWorkflow,
  getDashboardStats,
  getRecentRuns,
  getSidebarProjects,
} from '@/lib/api/dashboardServer';
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

  const [projects, stats, continueWorkflow, recentRuns] = await Promise.all([
    getSidebarProjects(),
    getDashboardStats(),
    getContinueWorkflow(),
    getRecentRuns(),
  ]);

  const plan = getPlanUsage(stats.workflowCount);
  const greeting = greetingForHour(new Date().getHours());

  return (
    <AppShell topBar={<TopBar orgName={user.org?.name ?? null} email={user.email} />}>
      <Sidebar orgId={orgId} role={user.role} projects={projects} email={user.email} />
      <div style={mainColStyle}>
        <HomeContent
          greeting={greeting}
          fullName={user.fullName}
          continueWorkflow={continueWorkflow}
          recentRuns={recentRuns}
          plan={plan}
          stats={stats}
        />
      </div>
    </AppShell>
  );
}
