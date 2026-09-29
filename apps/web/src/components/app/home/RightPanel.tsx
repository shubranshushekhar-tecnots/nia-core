import Avatar from '@/components/Avatar';
import type { PlanUsage } from '@/lib/billing/plan';
import type { ActivityItem, NeedsAttentionItem } from '@/lib/dashboard/homeViewModel';

const STATUS_DOT: Record<ActivityItem['status'], { dot: string; bg: string; verb: string }> = {
  succeeded: { dot: 'var(--chart-ok-hover)', bg: 'var(--success-bg)', verb: 'succeeded' },
  failed: { dot: 'var(--chart-fail)', bg: 'var(--danger-bg)', verb: 'failed' },
  running: { dot: 'var(--ink-300)', bg: 'var(--line-100)', verb: 'is running' },
};

function ProfileCard({ userId, fullName, workspaceLabel, plan }: { userId: string; fullName: string | null; workspaceLabel: string; plan: PlanUsage }) {
  const pct =
    plan.workflowLimit === null ? 0 : Math.min(100, Math.round((100 * plan.workflowUsed) / plan.workflowLimit));
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '24px 16px 20px',
        background: 'var(--canvas)',
        borderRadius: 14,
      }}
    >
      <Avatar seed={userId} size={72} shuffle title="Your avatar" />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{fullName ?? 'You'}</span>
        <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>{workspaceLabel}</span>
      </div>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ color: 'var(--ink-200)' }}>Workflows used</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ fontWeight: 600 }}>{plan.workflowUsed}</span>{' '}
            <span style={{ color: 'var(--ink-300)' }}>/ {plan.workflowLimit === null ? 'Unlimited' : plan.workflowLimit}</span>
          </span>
        </div>
        <div
          role="meter"
          aria-valuenow={plan.workflowUsed}
          aria-valuemin={0}
          aria-valuemax={plan.workflowLimit ?? undefined}
          aria-label="Workflows used"
          style={{ height: 6, borderRadius: 3, background: 'var(--line-200)', overflow: 'hidden' }}
        >
          <div style={{ width: `${pct}%`, height: 6, borderRadius: 3, background: 'var(--acc)' }} />
        </div>
      </div>
    </div>
  );
}

function NeedsAttention({ items }: { items: NeedsAttentionItem[] }) {
  return (
    <section aria-label="Needs attention" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Needs attention</h2>
        {items.length > 0 && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              lineHeight: '18px',
              padding: '0 7px',
              borderRadius: 6,
              background: 'var(--warning-bg)',
              color: 'var(--warning)',
            }}
          >
            {items.length}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>Nothing needs attention right now.</span>
      ) : (
        items.map((item) => (
          <div
            key={item.workflowId}
            style={{ display: 'flex', gap: 10, padding: 12, border: '1px solid var(--danger-border)', background: 'var(--danger-bg)', borderRadius: 10 }}
          >
            <svg viewBox="0 0 24 24" style={{ width: 18, height: 18, color: 'var(--danger)', marginTop: 2, flexShrink: 0 }} fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx={12} cy={12} r={9} />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 500, fontSize: 13.5 }}>{item.workflowName} failed</span>
              <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>{item.when}</span>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function Activity({ items }: { items: ActivityItem[] }) {
  return (
    <section aria-label="Activity" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>Activity</h2>
      {items.length === 0 ? (
        <span style={{ fontSize: 12.5, color: 'var(--ink-200)' }}>No activity yet.</span>
      ) : (
        items.map((item) => {
          const s = STATUS_DOT[item.status];
          return (
            <div key={item.id} style={{ display: 'flex', gap: 12, padding: '8px 0' }}>
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: s.bg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: s.dot }} />
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13 }}>
                  <span style={{ fontWeight: 500 }}>{item.workflowName}</span> <span style={{ color: 'var(--ink-200)' }}>{s.verb}</span>
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: 'var(--ink-300)' }}>{item.meta}</span>
              </div>
              <span style={{ fontSize: 12, color: 'var(--ink-300)', whiteSpace: 'nowrap' }}>{item.when}</span>
            </div>
          );
        })
      )}
    </section>
  );
}

export default function RightPanel({
  userId,
  fullName,
  workspaceLabel,
  plan,
  needsAttention,
  activity,
}: {
  userId: string;
  fullName: string | null;
  workspaceLabel: string;
  plan: PlanUsage;
  needsAttention: NeedsAttentionItem[];
  activity: ActivityItem[];
}) {
  return (
    <aside
      aria-label="You and activity"
      style={{
        width: 340,
        flexShrink: 0,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--line-100)',
        padding: '24px 20px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      <ProfileCard userId={userId} fullName={fullName} workspaceLabel={workspaceLabel} plan={plan} />
      <NeedsAttention items={needsAttention} />
      <Activity items={activity} />
    </aside>
  );
}
