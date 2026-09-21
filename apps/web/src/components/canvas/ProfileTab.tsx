'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PARSE_STAT_KEYS, type ColumnStats, type EntityRef } from '@nia/schemas';
import { getConnectionProfile, refreshConnectionProfile } from '@/lib/api/connectionsClient';

/**
 * Phase 10 Step 3E — source node config panel's Profile tab. Deliberately
 * plain per the plan's own instruction: one card per column (not a wide
 * table — this panel is only FLOATING_PANEL_WIDTH=360px, see styles.ts),
 * declared type, null %, distinct count, missing-token count, min/max
 * (numeric/date) or min/max length (text), and — for text columns only —
 * each attempted parse function's pass rate with its failing examples
 * surfaced via a native title tooltip (already-truncated strings per
 * profile.ts's MAX_EXAMPLE_VALUE_CHARS, so no extra clamping needed here).
 */

const sampleMethodLabel: Record<string, string> = {
  'keyset-head-tail': 'First + last 5,000 rows',
  'full-table': 'Full table (smaller than sample size)',
  'no-key-scan': 'Single unordered page (no usable key)',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
  gap: 8,
} as const;

const metaStyle = {
  fontSize: 11.5,
  color: 'var(--ink4)',
  lineHeight: 1.5,
} as const;

const refreshBtnStyle = {
  flex: 'none',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--ink)',
  background: 'var(--surface2)',
  border: '1px solid var(--line2)',
  borderRadius: 6,
  padding: '5px 10px',
  cursor: 'pointer',
} as const;

const columnCardStyle = {
  border: '1px solid var(--line2)',
  borderRadius: 8,
  padding: '8px 10px',
  marginBottom: 8,
} as const;

const columnHeaderStyle = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 6,
} as const;

const columnNameStyle = {
  fontFamily: 'var(--font-data)',
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--ink)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const columnTypeStyle = {
  fontSize: 11,
  color: 'var(--ink4)',
  flex: 'none',
} as const;

const statGridStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 12px',
} as const;

const statStyle = {
  fontSize: 11,
  color: 'var(--ink3)',
} as const;

const parseRatesWrapStyle = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: '1px solid var(--line)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
} as const;

const parseRateRowStyle = {
  fontSize: 11,
  color: 'var(--ink3)',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
} as const;

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '\u2014';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function formatMinMax(value: number | string | null): string {
  if (value === null) return '\u2014';
  return typeof value === 'number' ? String(value) : value;
}

function ColumnCard({ col }: { col: ColumnStats }) {
  const parseKeysPresent = col.parseRates ? PARSE_STAT_KEYS.filter((k) => col.parseRates![k] && col.parseRates![k]!.attempted > 0) : [];
  return (
    <div style={columnCardStyle}>
      <div style={columnHeaderStyle}>
        <span style={columnNameStyle} title={col.name}>
          {col.name}
        </span>
        <span style={columnTypeStyle}>{col.declaredType}</span>
      </div>
      <div style={statGridStyle}>
        <span style={statStyle}>Null {pct(col.nullCount, col.sampleCount)}</span>
        <span style={statStyle}>Distinct {col.distinctCount}</span>
        {col.missingTokenCount > 0 && <span style={statStyle}>Missing tokens {col.missingTokenCount}</span>}
        {col.emptyStringCount > 0 && <span style={statStyle}>Empty {col.emptyStringCount}</span>}
        {col.whitespaceOnlyCount > 0 && <span style={statStyle}>Blank {col.whitespaceOnlyCount}</span>}
        {col.min !== null && <span style={statStyle}>Range {formatMinMax(col.min)}–{formatMinMax(col.max)}</span>}
        {col.minLength !== null && <span style={statStyle}>Length {col.minLength}–{col.maxLength}</span>}
      </div>
      {parseKeysPresent.length > 0 && (
        <div style={parseRatesWrapStyle}>
          {parseKeysPresent.map((key) => {
            const rate = col.parseRates![key]!;
            const title = rate.failingExamples.length > 0 ? `Failing examples: ${rate.failingExamples.join(', ')}` : undefined;
            return (
              <div key={key} style={parseRateRowStyle} title={title}>
                <span>{key}</span>
                <span>{pct(rate.passed, rate.attempted)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function ProfileTab({ connectionId, entity }: { connectionId: string; entity: EntityRef }) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const queryKey = ['connection-profile', connectionId, entity.namespace, entity.name];

  const { data: profile, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getConnectionProfile(connectionId, entity),
  });

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const next = await refreshConnectionProfile(connectionId, entity);
      queryClient.setQueryData(queryKey, next);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Failed to refresh profile.');
    } finally {
      setRefreshing(false);
    }
  }

  if (isLoading) {
    return <div style={{ fontSize: 12, color: 'var(--ink4)' }}>Profiling {entity.namespace ? `${entity.namespace}.${entity.name}` : entity.name}…</div>;
  }

  if (error || !profile) {
    return (
      <div style={{ fontSize: 12, color: 'var(--warn)' }}>
        {error instanceof Error ? error.message : 'Failed to load profile.'}
      </div>
    );
  }

  return (
    <div>
      <div style={headerStyle}>
        <div style={metaStyle}>
          {sampleMethodLabel[profile.sampleMethod] ?? profile.sampleMethod} · {profile.sampleSize} rows sampled
          <br />
          Profiled {new Date(profile.profiledAt).toLocaleString()}
        </div>
        <button type="button" style={refreshBtnStyle} disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {refreshError && <div style={{ fontSize: 11.5, color: 'var(--warn)', marginBottom: 8 }}>{refreshError}</div>}
      {profile.columns.map((col) => (
        <ColumnCard key={col.name} col={col} />
      ))}
    </div>
  );
}
