'use client';

import { useState, useTransition } from 'react';
import { loadUsageDataAction } from '@/lib/console/actions';
import { ensureBearerToken } from '@/lib/auth/browserSession';
import type { ConsoleUsageBreakdownRow, ConsoleUsageData, ConsoleUsageFilters } from '@/lib/api/consoleServer';
import ConsoleUsageCharts, { formatUsd } from './ConsoleUsageCharts';
import {
  consoleContentStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consolePrimaryBtnStyle,
  consoleSectionTitleStyle,
  consoleStatCardStyle,
  consoleStatLabelStyle,
  consoleStatValueStyle,
  consoleStatsRowStyle,
} from './styles';
import {
  consoleUsageColCostStyle,
  consoleUsageColLabelStyle,
  consoleUsageColNumberStyle,
  consoleUsageFilterActionsStyle,
  consoleUsageFilterBarStyle,
  consoleUsageFilterErrorStyle,
  consoleUsageFilterFieldStyle,
  consoleUsageFilterInputStyle,
  consoleUsageFilterLabelStyle,
  consoleUsageRowStyle,
  consoleUsageSectionStyle,
  consoleUsageSectionsRowStyle,
  consoleUsageTableHeadRowStyle,
  consoleUsageTableWrapStyle,
} from './usageStyles';

type FilterForm = {
  dateFrom: string;
  dateTo: string;
  orgId: string;
  model: string;
  feature: string;
};

const EMPTY_FORM: FilterForm = { dateFrom: '', dateTo: '', orgId: '', model: '', feature: '' };

/** Local <input type="date"> value ('YYYY-MM-DD') -> the ISO datetime-with-offset string the API's z.string().datetime({ offset: true }) requires. */
function dateInputToIso(value: string, endOfDay: boolean): string | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return d.toISOString();
}

function formToFilters(form: FilterForm): ConsoleUsageFilters {
  return {
    dateFrom: dateInputToIso(form.dateFrom, false),
    dateTo: dateInputToIso(form.dateTo, true),
    orgId: form.orgId.trim() || undefined,
    model: form.model.trim() || undefined,
    feature: form.feature.trim() || undefined,
  };
}

function BreakdownTable({ title, rows }: { title: string; rows: ConsoleUsageBreakdownRow[] }) {
  return (
    <div style={consoleUsageSectionStyle}>
      <h3 style={consoleSectionTitleStyle}>{title}</h3>
      <div style={consoleUsageTableWrapStyle}>
        <div style={consoleUsageTableHeadRowStyle}>
          <span style={consoleUsageColLabelStyle}>Name</span>
          <span style={consoleUsageColNumberStyle}>Input</span>
          <span style={consoleUsageColNumberStyle}>Output</span>
          <span style={consoleUsageColNumberStyle}>Calls</span>
          <span style={consoleUsageColCostStyle}>Cost</span>
        </div>
        {rows.length === 0 ? (
          <div style={consoleEmptyStyle}>No usage in this range.</div>
        ) : (
          rows.map((row) => (
            <div key={row.key} style={consoleUsageRowStyle}>
              <span style={consoleUsageColLabelStyle}>{row.label}</span>
              <span style={consoleUsageColNumberStyle}>{row.inputTokens.toLocaleString()}</span>
              <span style={consoleUsageColNumberStyle}>{row.outputTokens.toLocaleString()}</span>
              <span style={consoleUsageColNumberStyle}>{row.callCount.toLocaleString()}</span>
              <span style={consoleUsageColCostStyle}>{formatUsd(row.cost)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TopConsumersList({ title, rows }: { title: string; rows: ConsoleUsageBreakdownRow[] }) {
  return (
    <div style={consoleUsageSectionStyle}>
      <h3 style={consoleSectionTitleStyle}>{title}</h3>
      <div style={consoleUsageTableWrapStyle}>
        {rows.length === 0 ? (
          <div style={consoleEmptyStyle}>No usage in this range.</div>
        ) : (
          rows.map((row, i) => (
            <div key={row.key} style={consoleUsageRowStyle}>
              <span style={{ ...consoleUsageColNumberStyle, flex: '0 1 24px', minWidth: 20 }}>{i + 1}</span>
              <span style={consoleUsageColLabelStyle}>{row.label}</span>
              <span style={consoleUsageColCostStyle}>{formatUsd(row.cost)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function ConsoleUsageClient({ initialData }: { initialData: ConsoleUsageData }) {
  const [form, setForm] = useState<FilterForm>(EMPTY_FORM);
  const [data, setData] = useState<ConsoleUsageData>(initialData);
  const [error, setError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isExporting, setIsExporting] = useState(false);

  function reload(nextForm: FilterForm) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await loadUsageDataAction(formToFilters(nextForm));
        setData(result);
      } catch {
        setError("Couldn't load usage data. Try again.");
      }
    });
  }

  function handleApply() {
    reload(form);
  }

  function handleReset() {
    setForm(EMPTY_FORM);
    reload(EMPTY_FORM);
  }

  async function handleExport() {
    setExportError(null);
    setIsExporting(true);
    try {
      const token = await ensureBearerToken();
      if (!token) {
        setExportError('Your session expired. Reload and sign in again.');
        return;
      }
      const query = new URLSearchParams();
      const filters = formToFilters(form);
      if (filters.dateFrom) query.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) query.set('dateTo', filters.dateTo);
      if (filters.orgId) query.set('orgId', filters.orgId);
      if (filters.model) query.set('model', filters.model);
      if (filters.feature) query.set('feature', filters.feature);
      query.set('by', 'day');

      const res = await fetch(`/api/backend/console/usage/export?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setExportError("Couldn't export usage data. Try again.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'llm-usage-day.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("Couldn't export usage data. Try again.");
    } finally {
      setIsExporting(false);
    }
  }

  const { summary, timeseries, byModel, byFeature, topConsumers } = data;

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <h1 style={consoleHeaderTitleStyle}>Token usage</h1>
          <span style={consoleHeaderSubStyle}>LLM tokens and cost across every org and feature.</span>
        </div>
        <button type="button" style={consoleGhostBtnStyle} onClick={handleExport} disabled={isExporting}>
          {isExporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>
      {exportError && <span style={consoleUsageFilterErrorStyle}>{exportError}</span>}

      <div style={consoleUsageFilterBarStyle}>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="usage-date-from">
            From
          </label>
          <input
            id="usage-date-from"
            type="date"
            style={consoleUsageFilterInputStyle}
            value={form.dateFrom}
            onChange={(e) => setForm((f) => ({ ...f, dateFrom: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="usage-date-to">
            To
          </label>
          <input
            id="usage-date-to"
            type="date"
            style={consoleUsageFilterInputStyle}
            value={form.dateTo}
            onChange={(e) => setForm((f) => ({ ...f, dateTo: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="usage-org-id">
            Org ID
          </label>
          <input
            id="usage-org-id"
            type="text"
            placeholder="uuid"
            style={consoleUsageFilterInputStyle}
            value={form.orgId}
            onChange={(e) => setForm((f) => ({ ...f, orgId: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="usage-model">
            Model
          </label>
          <input
            id="usage-model"
            type="text"
            style={consoleUsageFilterInputStyle}
            value={form.model}
            onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterFieldStyle}>
          <label style={consoleUsageFilterLabelStyle} htmlFor="usage-feature">
            Feature
          </label>
          <input
            id="usage-feature"
            type="text"
            style={consoleUsageFilterInputStyle}
            value={form.feature}
            onChange={(e) => setForm((f) => ({ ...f, feature: e.target.value }))}
          />
        </div>
        <div style={consoleUsageFilterActionsStyle}>
          <button type="button" style={consoleGhostBtnStyle} onClick={handleReset} disabled={isPending}>
            Reset
          </button>
          <button type="button" style={consolePrimaryBtnStyle} onClick={handleApply} disabled={isPending}>
            {isPending ? 'Loading…' : 'Apply filters'}
          </button>
        </div>
        {error && <span style={consoleUsageFilterErrorStyle}>{error}</span>}
      </div>

      <div style={consoleStatsRowStyle}>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Today — tokens</span>
          <span style={consoleStatValueStyle}>{summary.today.totalTokens.toLocaleString()}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>Today — cost</span>
          <span style={consoleStatValueStyle}>{formatUsd(summary.today.cost)}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>This month — tokens</span>
          <span style={consoleStatValueStyle}>{summary.month.totalTokens.toLocaleString()}</span>
        </div>
        <div style={consoleStatCardStyle}>
          <span style={consoleStatLabelStyle}>This month — cost</span>
          <span style={consoleStatValueStyle}>{formatUsd(summary.month.cost)}</span>
        </div>
      </div>

      <ConsoleUsageCharts timeseries={timeseries} />

      <div style={consoleUsageSectionsRowStyle}>
        <BreakdownTable title="By model" rows={byModel} />
        <BreakdownTable title="By feature" rows={byFeature} />
      </div>

      <div style={consoleUsageSectionsRowStyle}>
        <TopConsumersList title="Top orgs by cost" rows={topConsumers.topOrgs} />
        <TopConsumersList title="Top users by cost" rows={topConsumers.topUsers} />
      </div>
    </div>
  );
}
