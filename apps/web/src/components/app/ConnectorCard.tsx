'use client';

import { useActionState, useEffect, type CSSProperties } from 'react';
import { installConnectorAction } from '@/lib/connections/actions';
import type { ConnectorCatalogMeta } from '@/lib/connections/catalogMeta';
import ConnectorLogo from './ConnectorLogo';
import type { ConnectorCategory } from './styles';
import {
  nxConnectorCardShellStyle,
  nxConnectorCardArtStyle,
  nxConnectorCardDotsStyle,
  nxConnectorCardCategoryStyle,
  nxConnectorCardBadgeStyle,
  nxConnectorCardBodyStyle,
  nxConnectorCardNameStyle,
  nxConnectorCardSubtitleStyle,
  nxConnectorCardDescStyle,
  nxConnectorCardActionsStyle,
  nxConnectorCardMainBtnStyle,
  nxConnectorCardDocsBtnStyle,
  nxModalErrorStyle,
} from './styles';

const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  databases: 'Database',
  warehouses: 'Warehouse',
  bi: 'BI',
  'ai-vector': 'AI Vector',
  files: 'Files',
};

/**
 * Card v5 — Precision Dark redesign (Step 4, Connections). Static
 * Swiss-grid card: a fixed-height art band (giant logo mark bottom-left,
 * category label top-left, connected/soon badge top-right) over a body
 * (name/subtitle/description) and an actions row (main button + docs
 * button). Replaces the old v4 hover-morph card — the dark hover view's
 * text (name/category/description) was always identical to the rest
 * text, so a single static layout loses nothing. Hover/focus-within only
 * shifts the card's background to --nx-surface (`.nx-conn-card` in
 * theme.css) and triggers the action row's `.nx-wipe` hover treatment —
 * no size/opacity morph, no glide.
 */
export default function ConnectorCard({
  meta,
  installed,
  connectionCount = 0,
  onInstalled,
  onUninstall,
}: {
  meta: ConnectorCatalogMeta;
  installed: boolean;
  connectionCount?: number;
  onInstalled?: (connectorId: string) => void;
  // Installed cards' main button is a destructive "Uninstall" action —
  // opens the parent page's uninstall-confirm dialog.
  onUninstall?: (connectorId: string) => void;
}) {
  const [installState, installAction, installPending] = useActionState(
    installConnectorAction.bind(null, meta.id),
    null,
  );

  useEffect(() => {
    if (installState?.success) onInstalled?.(meta.id);
  }, [installState, meta.id, onInstalled]);

  const loginMethod = meta.authMethod;
  const subtitle = `${CATEGORY_LABEL[meta.category]}${loginMethod ? ` \u00b7 ${loginMethod}` : ''}`;

  const badge: { kind: 'connected' | 'installed' | 'soon'; label: string } | null = meta.comingSoon
    ? { kind: 'soon', label: 'Coming soon' }
    : installed
      ? connectionCount > 0
        ? { kind: 'connected', label: `${connectionCount} connected` }
        : { kind: 'installed', label: 'Installed' }
      : null;

  // Item 7's glyph display rule: --nx-blue-panel when installed/connected,
  // --nx-raised otherwise (not installed, or coming soon).
  const glyphColor = installed ? 'var(--nx-blue-panel)' : 'var(--nx-raised)';

  const mainKind = meta.comingSoon ? 'notify' : installed ? 'uninstall' : 'install';

  function handleUninstallClick() {
    onUninstall?.(meta.id);
  }

  const mainButton =
    mainKind === 'notify' ? (
      <button type="button" disabled className="nx-wipe" style={{ ...nxConnectorCardMainBtnStyle('notify'), opacity: 0.5, cursor: 'not-allowed' }}>
        Notify me
        <span aria-hidden="true">Soon</span>
      </button>
    ) : mainKind === 'uninstall' ? (
      <button
        type="button"
        className="nx-wipe"
        style={{ ...nxConnectorCardMainBtnStyle('uninstall'), '--wipe-fill': 'var(--nx-danger)', '--wipe-on': 'var(--nx-bg)' } as CSSProperties}
        onClick={handleUninstallClick}
      >
        Uninstall
        <span aria-hidden="true">{'\u00d7'}</span>
      </button>
    ) : (
      <form action={installAction} style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
        <button
          type="submit"
          disabled={installPending}
          className="nx-wipe"
          style={{ ...nxConnectorCardMainBtnStyle('install'), width: '100%', '--wipe-fill': 'var(--nx-blue-panel)', '--wipe-on': 'var(--nx-blue-panel-text)' } as CSSProperties}
        >
          {installPending ? 'Installing\u2026' : 'Install'}
          <span aria-hidden="true">{'\u2192'}</span>
        </button>
      </form>
    );

  const docsButton = meta.docsUrl ? (
    <a
      href={meta.docsUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="nx-wipe"
      style={nxConnectorCardDocsBtnStyle}
      aria-label={`${meta.name} documentation`}
    >
      Docs
    </a>
  ) : (
    <button
      type="button"
      disabled
      style={{ ...nxConnectorCardDocsBtnStyle, opacity: 0.4, cursor: 'not-allowed' }}
      aria-label="Docs coming soon"
    >
      Docs
    </button>
  );

  return (
    <div
      className="nx-conn-card"
      style={nxConnectorCardShellStyle}
      data-testid="connector-card"
      data-connector-id={meta.id}
    >
      <div style={nxConnectorCardArtStyle}>
        <div style={nxConnectorCardDotsStyle} aria-hidden="true" />
        <span style={nxConnectorCardCategoryStyle}>{CATEGORY_LABEL[meta.category]}</span>
        {badge && <span style={nxConnectorCardBadgeStyle(badge.kind)}>{badge.label}</span>}
        <span data-testid="connector-logo">
          <ConnectorLogo id={meta.id} giant giantColor={glyphColor} />
        </span>
      </div>

      <div style={nxConnectorCardBodyStyle}>
        <span style={nxConnectorCardNameStyle}>{meta.name}</span>
        <span style={nxConnectorCardSubtitleStyle}>{subtitle}</span>
        <span style={nxConnectorCardDescStyle}>{meta.description}</span>
        {meta.id === 'sqlserver-agent' && (
          <span style={{ fontSize: 11.5, color: 'var(--nx-ink-3)' }}>
            Needs Nia Core Agent installed on a machine that can reach the database.{' '}
            <a href="/downloads" style={{ color: 'var(--nx-ink-2)' }}>
              Download
            </a>
          </span>
        )}
        {installState?.error && (
          <span style={nxModalErrorStyle}>
            {installState.error}
            {installState.errorFix && <span style={{ display: 'block', marginTop: 2 }}>{installState.errorFix}</span>}
          </span>
        )}
      </div>

      <div style={nxConnectorCardActionsStyle}>
        {mainButton}
        {docsButton}
      </div>
    </div>
  );
}
