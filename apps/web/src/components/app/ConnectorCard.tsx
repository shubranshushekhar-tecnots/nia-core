'use client';

import { useActionState, useEffect, useState, type FocusEvent } from 'react';
import { installConnectorAction } from '@/lib/connections/actions';
import type { ConnectorCatalogMeta } from '@/lib/connections/catalogMeta';
import ConnectorLogo from './ConnectorLogo';
import type { ConnectorCategory } from './styles';
import {
  CARD,
  connectorCardShellStyle,
  connectorMediaStyle,
  connectorCategoryLabelStyle,
  connectorTopBadgeStyle,
  connectorBadgeDotStyle,
  connectorLogoBoxStyle,
  connectorRestTextStyle,
  connectorNameStyle,
  connectorSubtitleStyle,
  connectorDescStyle,
  connectorFooterStyle,
  connectorMainButtonStyle,
  connectorDocsIconBtnStyle,
  connectorDarkWrapStyle,
  connectorDarkCategoryLabelStyle,
  connectorDarkNameStyle,
  connectorDarkDescStyle,
  modalErrorStyle,
} from './styles';

const CATEGORY_LABEL: Record<ConnectorCategory, string> = {
  databases: 'Database',
  warehouses: 'Warehouse',
  bi: 'BI',
  'ai-vector': 'AI Vector',
  files: 'Files',
};

function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

/**
 * Card v4 — a fixed 472px card with a rest view (name/kind/description/
 * facts below a 220px media band) and a hover/focus view (card turns
 * #0A0A0B, logo glides to a small top-left mark, a bottom-anchored dark
 * text block replaces the rest text). Ported 1:1 from designs/Connections
 * — with connections-html/Connections.dc.html's `cardBuilder`.
 *
 * Both views stay mounted at all times (only opacity/position/pointer-
 * events toggle) so a keyboard user tabbing into the card doesn't hit a
 * remount that steals focus. The footer (main button + Docs button) is a
 * single always-visible element that only recolors between states — no
 * more duplicated light/dark button pairs, so there's only one button in
 * the tab order.
 *
 * `active` = hovered OR focus is somewhere inside the card (mouse hover
 * and keyboard focus get the same hover-view treatment). `reducedMotion`
 * (matchMedia) shortens every transition to a plain 120ms fade per the
 * design's `prefers-reduced-motion` note. Touch devices simply never set
 * `hovered` (no touch hover event), so they stay in the rest view and a
 * tap on the main button still fires a normal click.
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
  const [hovered, setHovered] = useState(false);
  const [focusedWithin, setFocusedWithin] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const active = hovered || focusedWithin;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  function handleBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedWithin(false);
  }

  const [installState, installAction, installPending] = useActionState(
    installConnectorAction.bind(null, meta.id),
    null,
  );

  useEffect(() => {
    if (installState?.success) onInstalled?.(meta.id);
  }, [installState, meta.id, onInstalled]);

  const loginMethod = meta.authMethod;
  const subtitle = `${CATEGORY_LABEL[meta.category]}${loginMethod ? ` \u00b7 ${loginMethod}` : ''}`;

  const badge: { kind: 'connected' | 'soon'; label: string } | null = meta.comingSoon
    ? { kind: 'soon', label: 'Coming soon' }
    : installed
      ? { kind: 'connected', label: connectionCount > 0 ? `${connectionCount} connected` : 'Installed' }
      : null;

  const mainKind = meta.comingSoon ? 'notify' : installed ? 'uninstall' : 'install';

  function handleUninstallClick() {
    onUninstall?.(meta.id);
  }

  const mainButton =
    mainKind === 'notify' ? (
      <button type="button" disabled style={connectorMainButtonStyle('notify', active, reducedMotion)}>
        Notify me
      </button>
    ) : mainKind === 'uninstall' ? (
      <button type="button" style={connectorMainButtonStyle('uninstall', active, reducedMotion)} onClick={handleUninstallClick}>
        Uninstall
      </button>
    ) : (
      <form action={installAction} style={{ flex: '1 1 auto', minWidth: 0, display: 'flex' }}>
        <button type="submit" disabled={installPending} style={connectorMainButtonStyle('install', active, reducedMotion)}>
          {installPending ? 'Installing\u2026' : 'Install'}
        </button>
      </form>
    );

  const docsButton = meta.docsUrl ? (
    <a
      href={meta.docsUrl}
      target="_blank"
      rel="noopener noreferrer"
      style={connectorDocsIconBtnStyle(active, reducedMotion)}
      aria-label={`${meta.name} documentation`}
    >
      <BookIcon />
    </a>
  ) : (
    <button
      type="button"
      disabled
      style={{ ...connectorDocsIconBtnStyle(active, reducedMotion), opacity: 0.4, cursor: 'not-allowed' }}
      aria-label="Docs coming soon"
    >
      <BookIcon />
    </button>
  );

  return (
    <div
      style={connectorCardShellStyle(active, meta.comingSoon, reducedMotion)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusedWithin(true)}
      onBlur={handleBlur}
      tabIndex={0}
      data-testid="connector-card"
      data-connector-id={meta.id}
    >
      <div style={connectorMediaStyle(active, reducedMotion)} aria-hidden="true" />

      <span style={connectorCategoryLabelStyle(active, reducedMotion)}>
        {CATEGORY_LABEL[meta.category]}
      </span>

      {badge && (
        <span style={connectorTopBadgeStyle(active, badge.kind, reducedMotion)}>
          <span style={connectorBadgeDotStyle(badge.kind)} aria-hidden="true" />
          {badge.label}
        </span>
      )}

      <span style={connectorLogoBoxStyle(active, reducedMotion)} data-testid="connector-logo">
        <ConnectorLogo id={meta.id} variant={active ? 'onDark' : 'default'} fill size={active ? CARD.imgHover : CARD.imgRest} />
      </span>

      <div style={connectorRestTextStyle(active, reducedMotion)}>
        <span style={connectorNameStyle}>{meta.name}</span>
        <span style={connectorSubtitleStyle}>{subtitle}</span>
        <span style={connectorDescStyle}>{meta.description}</span>
        {installState?.error && (
          <span style={{ ...modalErrorStyle, position: 'relative' }}>
            {installState.error}
            {installState.errorFix && <span style={{ display: 'block', marginTop: 2 }}>{installState.errorFix}</span>}
          </span>
        )}
      </div>

      <div style={connectorDarkWrapStyle(active, reducedMotion)}>
        <span style={connectorDarkCategoryLabelStyle}>{CATEGORY_LABEL[meta.category]}</span>
        <span style={connectorDarkNameStyle}>{meta.name}</span>
        <span style={connectorDarkDescStyle}>{meta.description}</span>
      </div>

      <div style={connectorFooterStyle}>
        {mainButton}
        {docsButton}
      </div>
    </div>
  );
}
