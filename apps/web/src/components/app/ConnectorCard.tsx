'use client';

import { useActionState, useEffect, useState } from 'react';
import { installConnectorAction } from '@/lib/connections/actions';
import type { ConnectorCatalogMeta } from '@/lib/connections/catalogMeta';
import ConnectorLogo from './ConnectorLogo';
import {
  SPHERE_DOT_COUNT,
  STACK_LAYER_COUNT,
  connectionsConnectorCardHoverStyle,
  connectionsConnectorCardStyle,
  connectionsConnectorDescStyle,
  connectionsConnectorIndexStyle,
  connectionsConnectorLogoStyle,
  connectionsConnectorNameStyle,
  connectionsConnectorTagStyle,
  connectionsConnectorTagsStyle,
  connectionsGraphicWrapStyle,
  connectionsInstallBtnStyle,
  connectionsInstallLabelStyle,
  connectionsInstallRowStyle,
  connectionsProviderMetaStyle,
  connectionsRoadmapIconStyle,
  connectionsRoadmapLabelStyle,
  connectionsRoadmapRowStyle,
  connectionsSoonBadgeStyle,
  connectionsSphereDotStyle,
  connectionsSphereHighlightStyle,
  connectionsSphereMainStyle,
  connectionsStackLayerStyle,
  connectionsUnavailableDescStyle,
  connectionsUnavailableGraphicStyle,
  connectionsUnavailableNameStyle,
  modalErrorStyle,
} from './styles';

// AI-vector connectors get the design's sphere motif; every other category
// gets the skewed "stacked cards" motif — same convention
// ConnectionsClient.tsx's old REAL_CONNECTOR_META/AVAILABLE constants used.
function graphicForCategory(category: ConnectorCatalogMeta['category']): 'cards' | 'sphere' {
  return category === 'ai-vector' ? 'sphere' : 'cards';
}

function ConnectorGraphic({ type }: { type: 'cards' | 'sphere' }) {
  return (
    <span aria-hidden="true" style={connectionsGraphicWrapStyle}>
      {type === 'cards'
        ? Array.from({ length: STACK_LAYER_COUNT }, (_, i) => <span key={i} style={connectionsStackLayerStyle(i)} />)
        : (
          <>
            <span style={connectionsSphereMainStyle} />
            <span style={connectionsSphereHighlightStyle} />
            {Array.from({ length: SPHERE_DOT_COUNT }, (_, i) => (
              <span key={i} style={connectionsSphereDotStyle(i)} />
            ))}
          </>
        )}
    </span>
  );
}

// Thin-line clock glyph for the "On the roadmap" row — matches the design's
// monochrome outline icon set better than an emoji glyph would.
function RoadmapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

// Checkmark glyph for the "Installed" state's install-row icon.
function InstalledIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function CardTags({ tags }: { tags: string[] }) {
  return (
    <div style={connectionsConnectorTagsStyle}>
      {tags.map((t) => (
        <span key={t} style={connectionsConnectorTagStyle}>
          {t}
        </span>
      ))}
    </div>
  );
}

/**
 * One catalog card — rest/hover states ported from the design's connector-
 * card markup (connectionsConnectorCardStyle/HoverStyle in styles.ts).
 * Hover applies on both mouse hover AND keyboard focus (:focus-visible
 * parity), so a keyboard user sees the same lift/shadow a mouse user does
 * before deciding whether to activate the card. Touch devices never fire a
 * persistent hover, so they only ever see the rest view.
 *
 * Three states for the 4 real, manifest-backed connectors (`comingSoon:
 * false`): not installed (clickable, submits `installConnectorAction`
 * directly — no credentials form on this page, per the intended product
 * model: install/uninstall only here, adding a connection happens on the
 * canvas), installing (pending, disabled), and installed (non-interactive,
 * points at the canvas for adding a connection). `comingSoon` cards render
 * the "SOON" badge / "On the roadmap" row and are never interactive.
 */
export default function ConnectorCard({
  meta,
  index,
  installed,
  onInstalled,
}: {
  meta: ConnectorCatalogMeta;
  index: string;
  installed: boolean;
  onInstalled?: (connectorId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const active = hovered || focused;
  const graphic = graphicForCategory(meta.category);

  const cardStyle = { ...connectionsConnectorCardStyle, ...(active ? connectionsConnectorCardHoverStyle : {}) };

  const [installState, installAction, installPending] = useActionState(
    installConnectorAction.bind(null, meta.id),
    null,
  );

  useEffect(() => {
    if (installState?.success) onInstalled?.(meta.id);
  }, [installState, meta.id, onInstalled]);

  if (meta.comingSoon) {
    return (
      <div
        style={cardStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span aria-hidden="true" style={connectionsUnavailableGraphicStyle} />
        <span style={connectionsSoonBadgeStyle}>SOON</span>
        {index && <span style={connectionsConnectorIndexStyle}>{index}</span>}
        <span style={connectionsUnavailableNameStyle}>{meta.name}</span>
        <span style={connectionsUnavailableDescStyle}>{meta.description}</span>
        <CardTags tags={meta.tags} />
        <div style={connectionsRoadmapRowStyle}>
          <span style={connectionsRoadmapIconStyle}>
            <RoadmapIcon />
          </span>
          <span style={connectionsRoadmapLabelStyle}>On the roadmap</span>
        </div>
      </div>
    );
  }

  if (installed) {
    return (
      <div
        style={cardStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <ConnectorGraphic type={graphic} />
        <span style={connectionsConnectorLogoStyle}>
          <ConnectorLogo id={meta.id} size={22} />
        </span>
        {index && <span style={connectionsConnectorIndexStyle}>{index}</span>}
        <span style={connectionsConnectorNameStyle}>{meta.name}</span>
        <span style={connectionsConnectorDescStyle}>{meta.description}</span>
        <CardTags tags={meta.tags} />
        <div style={connectionsInstallRowStyle}>
          <span
            style={{ ...connectionsInstallBtnStyle, background: 'var(--surface2)', color: 'var(--text-3)', cursor: 'default' }}
            aria-hidden="true"
          >
            <InstalledIcon />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={connectionsInstallLabelStyle}>Installed</span>
            <span style={connectionsProviderMetaStyle}>Add a connection from the canvas</span>
          </span>
        </div>
      </div>
    );
  }

  return (
    <form action={installAction}>
      <button
        type="submit"
        disabled={installPending}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...cardStyle,
          textAlign: 'left',
          fontFamily: 'inherit',
          cursor: installPending ? 'default' : 'pointer',
          width: '100%',
        }}
      >
        <ConnectorGraphic type={graphic} />
        <span style={connectionsConnectorLogoStyle}>
          <ConnectorLogo id={meta.id} size={22} />
        </span>
        {index && <span style={connectionsConnectorIndexStyle}>{index}</span>}
        <span style={connectionsConnectorNameStyle}>{meta.name}</span>
        <span style={connectionsConnectorDescStyle}>{meta.description}</span>
        <CardTags tags={meta.tags} />
        <div style={connectionsInstallRowStyle}>
          <span style={connectionsInstallBtnStyle} aria-hidden="true">
            {'\u2192'}
          </span>
          <span style={connectionsInstallLabelStyle}>{installPending ? 'Installing\u2026' : 'Install'}</span>
        </div>
        {installState?.error && (
          <span style={{ ...modalErrorStyle, position: 'relative' }}>
            {installState.error}
            {installState.errorFix && <span style={{ display: 'block', marginTop: 2 }}>{installState.errorFix}</span>}
          </span>
        )}
      </button>
    </form>
  );
}
