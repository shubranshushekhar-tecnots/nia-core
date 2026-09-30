import { PLAN_ALERT_THRESHOLD, type PlanUsage } from '@/lib/billing/plan';
import type { ActivityItem, NeedsAttentionItem } from '@/lib/dashboard/homeViewModel';

const STATUS_GLYPH: Record<ActivityItem['status'], { glyph: string; color: string; verb: string; pulsing?: boolean }> = {
  succeeded: { glyph: '\u25a0', color: 'var(--nx-success)', verb: 'succeeded' },
  failed: { glyph: '\u2715', color: 'var(--nx-danger-text)', verb: 'failed' },
  running: { glyph: '\u25a0', color: 'var(--nx-blue-panel)', verb: 'is running', pulsing: true },
};

const sectionHeadingStyle = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 22,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--nx-ink)',
} as const;

// Subscription Phase 3, Slice 4 — generalized so rows-moved/Copilot-action
// meters (added below) share the same markup as the pre-existing
// workflow-used meter instead of copy-pasting it twice more.
//
// Precision Dark redesign (Step 3): render-only restyle. Segmented (one
// cell per unit, 2px gaps) when the limit is 50 or less; a continuous
// square-ended bar above that; a full repeating stripe when unlimited.
// Warn state (--nx-warn fill + "N LEFT BEFORE THE LIMIT") triggers at the
// same PLAN_ALERT_THRESHOLD the page banners use.
const meterLabelStyle = {
  fontFamily: 'var(--nx-font-condensed)',
  fontStretch: '62.5%',
  fontWeight: 700,
  fontSize: 15,
  textTransform: 'uppercase',
  color: 'var(--nx-ink-2)',
} as const;

// Item 15: bar height 10px (was 6), fill is --nx-ink (not blue — blue is
// reserved for the CTA and the profile square), --nx-warn in the warn
// state, empty cells always --nx-raised.
function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit === null ? 0 : Math.min(100, (100 * used) / limit);
  const warn = limit !== null && limit > 0 && used / limit >= PLAN_ALERT_THRESHOLD;
  const left = limit === null ? null : Math.max(0, limit - used);
  const fillColor = warn ? 'var(--nx-warn)' : 'var(--nx-blue-panel)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={meterLabelStyle}>{label}</span>
        <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontWeight: 700, color: 'var(--nx-ink)' }}>{used.toLocaleString()}</span>{' '}
          <span style={{ color: 'var(--nx-ink-3)' }}>/ {limit === null ? 'Unlimited' : limit.toLocaleString()}</span>
        </span>
      </div>

      {limit === null ? (
        <div
          role="meter"
          aria-valuenow={used}
          aria-label={label}
          style={{
            height: 10,
            background: 'repeating-linear-gradient(45deg, var(--nx-line-inner) 0, var(--nx-line-inner) 4px, var(--nx-raised) 4px, var(--nx-raised) 8px)',
          }}
        />
      ) : limit <= 50 ? (
        <div role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label} style={{ display: 'flex', gap: 2 }}>
          {Array.from({ length: limit }).map((_, i) => (
            <span key={i} style={{ flex: 1, height: 10, background: i < used ? fillColor : 'var(--nx-raised)' }} />
          ))}
        </div>
      ) : (
        <div
          role="meter"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-label={label}
          style={{ height: 10, background: 'var(--nx-raised)' }}
        >
          <div style={{ width: `${pct}%`, height: 10, background: fillColor }} />
        </div>
      )}

      {warn && left !== null && (
        <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 11, color: 'var(--nx-warn)' }}>
          {left.toLocaleString()} LEFT BEFORE THE LIMIT
        </span>
      )}
    </div>
  );
}

export function initials(fullName: string | null): string {
  if (!fullName) return '?';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  const result = `${first}${last}`.toUpperCase();
  return result || '?';
}

function ProfileCard({ fullName, workspaceLabel, plan }: { fullName: string | null; workspaceLabel: string; plan: PlanUsage }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          aria-hidden
          style={{
            width: 72,
            height: 72,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--nx-blue-panel)',
            color: 'var(--nx-blue-panel-text)',
            fontFamily: 'var(--nx-font-condensed)',
            fontStretch: '62.5%',
            fontWeight: 800,
            fontSize: 40,
          }}
        >
          {initials(fullName)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontFamily: 'var(--font-inter-tight), var(--nx-font-ui)',
              fontSize: 20,
              fontWeight: 500,
              color: 'var(--nx-ink)',
            }}
          >
            {fullName ?? 'You'}
          </span>
          <span style={{ fontSize: 13, color: 'var(--nx-ink-2)' }}>{workspaceLabel}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <UsageMeter label="Workflows used" used={plan.workflowUsed} limit={plan.workflowLimit} />
        <UsageMeter label="Rows moved" used={plan.rowsUsed} limit={plan.rowsLimit} />
        <UsageMeter label="Copilot actions" used={plan.copilotUsed} limit={plan.copilotLimit} />
        <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 12, color: 'var(--nx-ink-3)' }}>
          {plan.periodDaysLeft} {plan.periodDaysLeft === 1 ? 'day' : 'days'} left this month
        </span>
      </div>
    </div>
  );
}

function NeedsAttention({ items }: { items: NeedsAttentionItem[] }) {
  return (
    <section aria-label="Needs attention" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, ...sectionHeadingStyle }}>Needs attention</h2>
        {items.length > 0 && (
          <span
            style={{
              fontFamily: 'var(--nx-font-mono)',
              fontSize: 11,
              fontWeight: 700,
              lineHeight: '18px',
              padding: '0 7px',
              background: 'var(--nx-danger)',
              color: 'var(--nx-bg)',
            }}
          >
            {items.length}
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <span style={{ fontSize: 12.5, color: 'var(--nx-ink-2)' }}>Nothing needs attention right now.</span>
      ) : (
        items.map((item) => (
          <div key={item.workflowId} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--nx-line-inner)' }}>
            <span style={{ fontSize: 13, color: 'var(--nx-danger-text)', flexShrink: 0, marginTop: 1 }} aria-hidden>
              {'\u2715'}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontWeight: 500, fontSize: 13.5, color: 'var(--nx-ink)' }}>{item.workflowName} failed</span>
              <span style={{ fontSize: 12.5, color: 'var(--nx-ink-2)' }}>{item.when}</span>
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
      <h2 style={{ margin: '0 0 8px', ...sectionHeadingStyle }}>Activity</h2>
      {items.length === 0 ? (
        <span style={{ fontSize: 12.5, color: 'var(--nx-ink-2)' }}>No activity yet.</span>
      ) : (
        items.map((item) => {
          const s = STATUS_GLYPH[item.status];
          return (
            <div key={item.id} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--nx-line-inner)' }}>
              <span
                aria-hidden
                style={{
                  width: 20,
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                  fontSize: 10,
                  color: s.color,
                  flexShrink: 0,
                  marginTop: 3,
                  animation: s.pulsing ? 'livePulse 1.4s ease-in-out infinite' : undefined,
                }}
              >
                {s.glyph}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: 'var(--nx-ink)' }}>
                  <span style={{ fontWeight: 500 }}>{item.workflowName}</span>{' '}
                  <span style={{ color: s.color }}>{s.verb}</span>
                </span>
                <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 11.5, color: 'var(--nx-ink-3)' }}>{item.meta}</span>
              </div>
              <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 12, color: 'var(--nx-ink-3)', whiteSpace: 'nowrap' }}>{item.when}</span>
            </div>
          );
        })
      )}
    </section>
  );
}

export default function RightPanel({
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
        background: 'var(--nx-bg)',
        borderLeft: '1px solid var(--nx-line)',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: '0 24px', borderBottom: '1px solid var(--nx-line)' }}>
        <ProfileCard fullName={fullName} workspaceLabel={workspaceLabel} plan={plan} />
      </div>
      <div style={{ padding: 24, borderBottom: '1px solid var(--nx-line)' }}>
        <NeedsAttention items={needsAttention} />
      </div>
      <div style={{ padding: 24 }}>
        <Activity items={activity} />
      </div>
    </aside>
  );
}
