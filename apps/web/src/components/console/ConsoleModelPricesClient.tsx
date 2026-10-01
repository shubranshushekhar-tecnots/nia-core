'use client';

import { useState, useTransition } from 'react';
import type { ConsoleModelPrice, ConsoleModelPricesPage } from '@/lib/api/consoleServer';
import { createModelPriceAction, loadModelPricesAction } from '@/lib/console/actions';
import {
  consoleColActionsStyle,
  consoleColRunsStyle,
  consoleContentStyle,
  consoleEmptyStyle,
  consoleGhostBtnStyle,
  consoleHeaderRowStyle,
  consoleHeaderSubStyle,
  consoleHeaderTitleColStyle,
  consoleHeaderTitleStyle,
  consoleLoadMoreRowStyle,
  consolePlanFieldLabelStyle,
  consolePlanFieldStyle,
  consolePlanFormActionsStyle,
  consolePlanFormErrorStyle,
  consolePlanFormStyle,
  consolePlanInputStyle,
  consolePrimaryBtnStyle,
  consoleRowNumberStyle,
  consoleRowStyle,
  consoleTableHeadRowStyle,
  consoleTableStyle,
} from './styles';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Console redesign plan's Slice 9 — Model Prices page. Catalog view of
 * public.model_prices (GET /console/model-prices, defaulting to the latest
 * row per model since the table is append-only) with "Load more" pagination
 * (ConsoleProjectsClient/ConsoleStaffClient pattern), a per-row "History"
 * toggle that swaps to that one model's full price history via ?history=,
 * and an "Add price" form (ConsolePlansClient's inline-form pattern, but
 * for creating a new row rather than editing one — this table is
 * append-only, so a price "correction" is always a new POST, never a PATCH).
 */
export default function ConsoleModelPricesClient({ initialPage }: { initialPage: ConsoleModelPricesPage }) {
  const [items, setItems] = useState(initialPage.items);
  const [offset, setOffset] = useState(initialPage.offset + initialPage.items.length);
  const [total, setTotal] = useState(initialPage.total);
  const [hasMore, setHasMore] = useState(initialPage.hasMore);
  const [historyModel, setHistoryModel] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function loadLatest() {
    setError(null);
    startTransition(async () => {
      try {
        const page = await loadModelPricesAction();
        setItems(page.items);
        setOffset(page.offset + page.items.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
        setHistoryModel(null);
      } catch {
        setError("Couldn't load model prices. Try again.");
      }
    });
  }

  function handleLoadMore() {
    setError(null);
    startTransition(async () => {
      try {
        const page = await loadModelPricesAction({ offset });
        setItems((prev) => [...prev, ...page.items]);
        setOffset(page.offset + page.items.length);
        setTotal(page.total);
        setHasMore(page.hasMore);
      } catch {
        setError("Couldn't load more model prices. Try again.");
      }
    });
  }

  function handleViewHistory(model: string) {
    setError(null);
    startTransition(async () => {
      try {
        const page = await loadModelPricesAction({ history: model });
        setItems(page.items);
        setTotal(page.total);
        setHasMore(false);
        setHistoryModel(model);
      } catch {
        setError("Couldn't load that model's price history. Try again.");
      }
    });
  }

  return (
    <div style={consoleContentStyle}>
      <div style={consoleHeaderRowStyle}>
        <div style={consoleHeaderTitleColStyle}>
          <span style={consoleHeaderTitleStyle}>Model Prices</span>
          <span style={consoleHeaderSubStyle}>
            {historyModel ? `${items.length} historical prices for ${historyModel}` : `Showing ${items.length} of ${total} models`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {historyModel && (
            <button type="button" style={consoleGhostBtnStyle} onClick={loadLatest} disabled={isPending}>
              Back to catalog
            </button>
          )}
          <button type="button" style={consoleGhostBtnStyle} onClick={() => setShowAddForm((v) => !v)}>
            {showAddForm ? 'Cancel' : 'Add price'}
          </button>
        </div>
      </div>

      {showAddForm && (
        <AddPriceForm
          onCancel={() => setShowAddForm(false)}
          onCreated={(price) => {
            setShowAddForm(false);
            if (!historyModel) {
              setItems((prev) => {
                const next = prev.filter((p) => p.model !== price.model);
                return [price, ...next];
              });
              setTotal((prev) => (items.some((p) => p.model === price.model) ? prev : prev + 1));
            } else if (historyModel === price.model) {
              setItems((prev) => [price, ...prev]);
              setTotal((prev) => prev + 1);
            }
          }}
        />
      )}

      {error && <span style={consolePlanFormErrorStyle}>{error}</span>}

      <div style={consoleTableStyle}>
        <div style={consoleTableHeadRowStyle}>
          <span style={{ flex: '1 1 140px', minWidth: 120 }}>Model</span>
          <span style={consoleColRunsStyle}>Input/1M</span>
          <span style={consoleColRunsStyle}>Output/1M</span>
          <span style={consoleColRunsStyle}>Cached/1M</span>
          <span style={{ flex: '0 1 70px', minWidth: 60 }}>Currency</span>
          <span style={{ flex: '0 1 140px', minWidth: 120 }}>Effective from</span>
          <span style={consoleColActionsStyle}></span>
        </div>

        {items.length === 0 && <div style={consoleEmptyStyle}>No model prices yet.</div>}

        {items.map((price) => (
          <div key={price.id} style={consoleRowStyle}>
            <span style={{ flex: '1 1 140px', minWidth: 120, fontSize: 13, color: 'var(--c-text)' }}>{price.model}</span>
            <span style={consoleRowNumberStyle}>{price.inputPricePer1m}</span>
            <span style={consoleRowNumberStyle}>{price.outputPricePer1m}</span>
            <span style={consoleRowNumberStyle}>{price.cachedPricePer1m ?? '\u2014'}</span>
            <span style={{ flex: '0 1 70px', minWidth: 60 }}>{price.currency}</span>
            <span style={{ flex: '0 1 140px', minWidth: 120 }}>{formatDate(price.effectiveFrom)}</span>
            <span style={consoleColActionsStyle}>
              {!historyModel && (
                <button type="button" style={consoleGhostBtnStyle} onClick={() => handleViewHistory(price.model)} disabled={isPending}>
                  History
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      {!historyModel && hasMore && (
        <div style={consoleLoadMoreRowStyle}>
          <button type="button" onClick={handleLoadMore} disabled={isPending} style={consoleGhostBtnStyle}>
            {isPending ? 'Loading\u2026' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function AddPriceForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (price: ConsoleModelPrice) => void;
}) {
  const [model, setModel] = useState('');
  const [inputPricePer1m, setInputPricePer1m] = useState('');
  const [outputPricePer1m, setOutputPricePer1m] = useState('');
  const [cachedPricePer1m, setCachedPricePer1m] = useState('');
  const [currency, setCurrency] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function parsePrice(label: string, raw: string, required: boolean): number | null | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (required) {
        setFormError(`${label} is required.`);
        return undefined;
      }
      return null;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      setFormError(`${label} must be a non-negative number.`);
      return undefined;
    }
    return n;
  }

  function handleSave() {
    setFormError(null);
    const trimmedModel = model.trim();
    if (!trimmedModel) {
      setFormError('Model is required.');
      return;
    }
    const parsedInput = parsePrice('Input price', inputPricePer1m, true);
    if (parsedInput === undefined || parsedInput === null) {
      if (parsedInput === null) setFormError('Input price is required.');
      return;
    }
    const parsedOutput = parsePrice('Output price', outputPricePer1m, true);
    if (parsedOutput === undefined || parsedOutput === null) {
      if (parsedOutput === null) setFormError('Output price is required.');
      return;
    }
    const parsedCached = parsePrice('Cached price', cachedPricePer1m, false);
    if (parsedCached === undefined) return;

    startTransition(async () => {
      const result = await createModelPriceAction({
        model: trimmedModel,
        inputPricePer1m: parsedInput,
        outputPricePer1m: parsedOutput,
        cachedPricePer1m: parsedCached ?? undefined,
        currency: currency.trim() || undefined,
      });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      onCreated(result.price);
    });
  }

  return (
    <div style={consolePlanFormStyle}>
      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor="model-price-model">
          Model
        </label>
        <input
          id="model-price-model"
          style={consolePlanInputStyle}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-5"
        />
      </div>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor="model-price-input">
          Input price/1M
        </label>
        <input
          id="model-price-input"
          style={consolePlanInputStyle}
          value={inputPricePer1m}
          onChange={(e) => setInputPricePer1m(e.target.value)}
          placeholder="5.00"
        />
      </div>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor="model-price-output">
          Output price/1M
        </label>
        <input
          id="model-price-output"
          style={consolePlanInputStyle}
          value={outputPricePer1m}
          onChange={(e) => setOutputPricePer1m(e.target.value)}
          placeholder="15.00"
        />
      </div>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor="model-price-cached">
          Cached price/1M
        </label>
        <input
          id="model-price-cached"
          style={consolePlanInputStyle}
          value={cachedPricePer1m}
          onChange={(e) => setCachedPricePer1m(e.target.value)}
          placeholder="Optional"
        />
      </div>

      <div style={consolePlanFieldStyle}>
        <label style={consolePlanFieldLabelStyle} htmlFor="model-price-currency">
          Currency
        </label>
        <input
          id="model-price-currency"
          style={consolePlanInputStyle}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          placeholder="USD"
        />
      </div>

      <div style={consolePlanFormActionsStyle}>
        <button type="button" onClick={handleSave} disabled={isPending} style={consolePrimaryBtnStyle}>
          {isPending ? 'Saving\u2026' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={isPending} style={consoleGhostBtnStyle}>
          Cancel
        </button>
      </div>

      {formError && <span style={consolePlanFormErrorStyle}>{formError}</span>}
    </div>
  );
}
