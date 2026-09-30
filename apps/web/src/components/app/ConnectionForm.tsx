'use client';

import { useRef, useState } from 'react';
import { buildReadOnlyStatementText, getHelpSection, suggestReadOnlyUsername, type ConfigField } from '@nia/schemas';
import { autoCompleteFor, urlPastePlaceholder } from '@/lib/connections/formFields';
import { parseExtraSchemas } from '@/lib/connections/parseExtraSchemas';
import HelpPanel from './HelpPanel';
import ConnectorLogo from './ConnectorLogo';
import { nxModalErrorStyle, nxModalFieldStyle, nxModalLabelStyle, nxModalTitleStyle } from './styles';

// Connect-form body, used by the canvas's AddConnectionDialog (single-step
// dialog, Server Action submit) — the only entry point for adding a
// connection (host, credentials, test). The Connections page itself only
// installs/uninstalls connectors (ConnectorCard); it never renders this
// form. The caller keeps its own shell: the <form> tag itself, and the
// Cancel/Submit actions row. This component renders only the fields + help
// affordances in between, as a fragment meant to be a direct child of the
// caller's own <form>.

// Generic structural check, not tied to a specific connectorId — any manifest
// shaped like a plain Postgres/MySQL credential form (host/port/database/
// user/password) gets the paste-a-URL convenience for free.
const URL_PASTE_KEYS = ['host', 'port', 'database', 'user', 'password'] as const;

// buildReadOnlyStatementText's extraSchemas option is Postgres/Supabase-only
// (mysql/mongodb are already database-wide) — same connectorId gate as the
// dialect switch in readOnlyStatement.ts.
const EXTRA_SCHEMAS_CONNECTOR_IDS = new Set(['postgres', 'supabase']);

function inputType(field: ConfigField): string {
  if (field.type === 'password') return 'password';
  if (field.type === 'number') return 'number';
  return 'text';
}

/** Learning-mode Layer 1 (docs/plans/learning-mode.md) — the read-only
 * helper's own generated credential, independent of whatever the user types
 * into the real Username/Password fields. Same duplicated-not-imported
 * `nia_<prefix>_<8 hex>` pattern as NodeDrawer.tsx's randomWriteRoleUser/
 * randomWriteRolePassword (see readOnlyStatement.ts's docblock). */
function randomReadOnlyUser(): string {
  return `nia_ro_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function randomReadOnlyPassword(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

const helpTriggerStyle = {
  fontFamily: 'var(--nx-font-mono)',
  fontSize: 11,
  letterSpacing: '0.03em',
  color: 'var(--nx-ink)',
  background: 'var(--nx-surface)',
  border: '1px solid var(--nx-line)',
  padding: '6px 10px',
  cursor: 'pointer',
} as const;

export type ConnectionFormErrors = {
  fieldErrors?: Record<string, string[]>;
  message?: string;
  fix?: string;
  details?: string;
};

export default function ConnectionForm({
  title,
  connectorName,
  connectorId,
  configSchema,
  idPrefix,
  errors,
}: {
  title: string;
  connectorName: string;
  connectorId: string;
  configSchema: ConfigField[];
  // Namespaces this instance's field ids. AddConnectionDialog (the sole
  // caller) passes "connection" — matches e2e's #connection-field-*
  // locators in help-panel.spec.ts/canvas.spec.ts, do not change.
  idPrefix: string;
  errors?: ConnectionFormErrors;
}) {
  const fieldRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const showUrlPaste = URL_PASTE_KEYS.every((k) => configSchema.some((f) => f.key === k));
  const [database, setDatabase] = useState('');
  const [readOnlyCredential] = useState(() => ({ user: randomReadOnlyUser(), password: randomReadOnlyPassword() }));
  const [readOnlyCopied, setReadOnlyCopied] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // The pasted connection URL's own username (e.g. "postgres.abcdefghijkl"
  // for a Supabase pooler URL) — kept separate from the generated read-only
  // credential so suggestReadOnlyUsername can derive the pooler project ref
  // from it without conflating the two usernames.
  const [pastedUsername, setPastedUsername] = useState<string | undefined>(undefined);
  const [extraSchemasInput, setExtraSchemasInput] = useState('');

  const showExtraSchemas = EXTRA_SCHEMAS_CONNECTOR_IDS.has(connectorId);
  const extraSchemas = showExtraSchemas ? parseExtraSchemas(extraSchemasInput) : undefined;
  const readOnlyStatement = buildReadOnlyStatementText(connectorId, database, readOnlyCredential.user, readOnlyCredential.password, {
    extraSchemas,
  });
  const readOnlyWhy = getHelpSection('read-only-user', connectorId)?.why;
  // Only meaningfully differs from readOnlyCredential.user when the pasted
  // URL's username carried a derivable Supabase pooler project ref (Step 1's
  // "postgres.<ref>" convention) — otherwise this is just the bare role name.
  const suggestedReadOnlyUsername = suggestReadOnlyUsername(readOnlyCredential.user, pastedUsername);
  const isPoolerQualified = suggestedReadOnlyUsername !== readOnlyCredential.user;

  async function handleCopyReadOnlyStatement() {
    if (!readOnlyStatement) return;
    await navigator.clipboard.writeText(readOnlyStatement);
    setReadOnlyCopied(true);
    setTimeout(() => setReadOnlyCopied(false), 1500);
  }

  function useReadOnlyCredential() {
    const refs = fieldRefs.current;
    if (refs.user) refs.user.value = suggestedReadOnlyUsername;
    if (refs.password) refs.password.value = readOnlyCredential.password;
  }

  function applyPastedUrl(value: string) {
    if (!value.trim()) return;
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      return; // ignore invalid/incomplete URL while typing
    }
    const refs = fieldRefs.current;
    if (refs.host) refs.host.value = url.hostname;
    if (refs.port) refs.port.value = url.port;
    const pastedDatabase = url.pathname.replace(/^\//, '');
    if (refs.database) refs.database.value = pastedDatabase;
    setDatabase(pastedDatabase);
    const pastedUrlUsername = decodeURIComponent(url.username);
    if (refs.user) refs.user.value = pastedUrlUsername;
    if (refs.password) refs.password.value = decodeURIComponent(url.password);
    setPastedUsername(pastedUrlUsername || undefined);
    if (refs.ssl) {
      const sslmode = url.searchParams.get('sslmode');
      refs.ssl.checked = Boolean(sslmode) && sslmode !== 'disable';
    }
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ConnectorLogo id={connectorId} tile={40} />
          <span style={nxModalTitleStyle}>{title}</span>
        </div>
        <button type="button" style={helpTriggerStyle} onClick={() => setShowHelp(true)}>
          Help with this step
        </button>
      </div>
      {showHelp && <HelpPanel step="add-connection" connectorId={connectorId} onClose={() => setShowHelp(false)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor={`${idPrefix}-display-name`} style={nxModalLabelStyle}>
          Name
        </label>
        <input
          id={`${idPrefix}-display-name`}
          name="displayName"
          type="text"
          placeholder={`My ${connectorName} connection`}
          className="nx-modal-field"
          style={nxModalFieldStyle(Boolean(errors?.fieldErrors?.displayName))}
        />
        {errors?.fieldErrors?.displayName && <span style={nxModalErrorStyle}>{errors.fieldErrors.displayName[0]}</span>}
      </div>

      {showUrlPaste && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor={`${idPrefix}-paste-url`} style={nxModalLabelStyle}>
            Paste connection URL (optional)
          </label>
          <input
            id={`${idPrefix}-paste-url`}
            type="text"
            placeholder={urlPastePlaceholder(connectorId)}
            className="nx-modal-field"
            style={nxModalFieldStyle(false)}
            onChange={(e) => applyPastedUrl(e.target.value)}
          />
        </div>
      )}

      {configSchema.map((field) => {
        if (field.type === 'boolean') {
          return (
            <div key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id={`${idPrefix}-field-${field.key}`}
                name={field.key}
                type="checkbox"
                // Boolean fields today are exactly one thing: "Use TLS"
                // (postgres/supabase's `ssl`). Defaulting to on matches
                // real hosted targets (Supabase, Neon, etc.) which all
                // require TLS — an unchecked-by-default toggle just
                // means most users silently fail their first connect.
                defaultChecked
                ref={(el) => {
                  fieldRefs.current[field.key] = el;
                }}
              />
              <label htmlFor={`${idPrefix}-field-${field.key}`} style={nxModalLabelStyle}>
                {field.label}
              </label>
            </div>
          );
        }
        return (
          <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor={`${idPrefix}-field-${field.key}`} style={nxModalLabelStyle}>
              {field.label}
            </label>
            <input
              id={`${idPrefix}-field-${field.key}`}
              name={field.key}
              type={inputType(field)}
              required={field.required}
              placeholder={field.placeholder}
              // The browser autofilling a *different* connection's saved
              // credentials (e.g. the Supabase admin login) into this
              // form is worse than useless here — every connection's
              // username/password is target-specific and should never be
              // suggested from another site/account's saved credentials.
              autoComplete={autoCompleteFor(field)}
              ref={(el) => {
                fieldRefs.current[field.key] = el;
              }}
              onChange={field.key === 'database' ? (e) => setDatabase(e.target.value) : undefined}
              className="nx-modal-field"
              style={nxModalFieldStyle(false)}
            />
          </div>
        );
      })}

      {readOnlyStatement && (
        // Collapsed by default — this is an optional convenience on top
        // of the plain Username/Password fields above, not a required
        // step, so it shouldn't visually compete with the "I already
        // have a user" path those fields already cover on their own.
        <details>
          <summary style={{ ...nxModalLabelStyle, cursor: 'pointer' }}>Need a read-only user?</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {readOnlyWhy && <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 11, color: 'var(--nx-ink-3)' }}>{readOnlyWhy}</span>}
            {showExtraSchemas && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label htmlFor={`${idPrefix}-extra-schemas`} style={nxModalLabelStyle}>
                  Extra schemas beyond &quot;public&quot; (optional)
                </label>
                <input
                  id={`${idPrefix}-extra-schemas`}
                  type="text"
                  placeholder="analytics, reporting"
                  value={extraSchemasInput}
                  onChange={(e) => setExtraSchemasInput(e.target.value)}
                  className="nx-modal-field"
                  style={nxModalFieldStyle(false)}
                />
              </div>
            )}
            <pre
              role="region"
              aria-label="Read-only user SQL statement"
              tabIndex={0}
              className="nx-focus-ring"
              style={{
                fontFamily: 'var(--nx-font-mono)',
                fontSize: 11,
                background: 'var(--nx-surface)',
                border: '1px solid var(--nx-line)',
                padding: 8,
                whiteSpace: 'pre-wrap',
                overflowX: 'auto',
                margin: 0,
              }}
            >
              {readOnlyStatement}
            </pre>
            {isPoolerQualified && (
              <span style={{ fontFamily: 'var(--nx-font-mono)', fontSize: 11, color: 'var(--nx-ink-3)' }}>
                Connect using the pooler-qualified username: <code>{suggestedReadOnlyUsername}</code>
              </span>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" style={helpTriggerStyle} onClick={handleCopyReadOnlyStatement}>
                {readOnlyCopied ? 'Copied' : 'Copy statement'}
              </button>
              <button type="button" style={helpTriggerStyle} onClick={useReadOnlyCredential}>
                Use these credentials
              </button>
            </div>
          </div>
        </details>
      )}

      {errors?.message && (
        <span style={nxModalErrorStyle}>
          {errors.message}
          {errors.fix && <span style={{ display: 'block', marginTop: 2 }}>{errors.fix}</span>}
          {errors.details && errors.details !== errors.message && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>Show details</summary>
              <span style={{ display: 'block', marginTop: 2 }}>{errors.details}</span>
            </details>
          )}
        </span>
      )}
    </>
  );
}
