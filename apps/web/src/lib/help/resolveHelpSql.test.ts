import { describe, expect, it } from 'vitest';
import {
  buildDropRoleStatementText,
  buildGrantStatementText,
  buildReadOnlyStatementText,
  HELP_STEP_CONNECTORS,
  type HelpSqlValues,
  type HelpStepKey,
} from '@nia/schemas';
import { resolveHelpSql, shouldShowCopyButton } from './resolveHelpSql';

const REAL_VALUES: HelpSqlValues = {
  database: 'acme_prod',
  namespace: 'acme_schema',
  roleUser: 'nia_ro_a1b2c3',
  rolePassword: 'RealGeneratedPassword987',
};

const SQL_STEPS: HelpStepKey[] = ['read-only-user', 'grant-write-access', 'revoke-access'];
const NO_SQL_STEPS: HelpStepKey[] = ['add-connection', 'test-connection', 'confirm-access'];

describe('resolveHelpSql — real mode', () => {
  it('returns mode "real" with text from the generator, using the caller-supplied values, for every sql step x connector', () => {
    for (const step of SQL_STEPS) {
      for (const connectorId of HELP_STEP_CONNECTORS[step]) {
        const resolved = resolveHelpSql(step, connectorId, REAL_VALUES);
        expect(resolved.mode).toBe('real');
        if (resolved.mode !== 'real') throw new Error('unreachable');

        const expected =
          step === 'read-only-user'
            ? buildReadOnlyStatementText(connectorId, REAL_VALUES.database, REAL_VALUES.roleUser, REAL_VALUES.rolePassword)
            : step === 'grant-write-access'
              ? buildGrantStatementText(connectorId, REAL_VALUES.namespace, REAL_VALUES.roleUser, REAL_VALUES.rolePassword)
              : buildDropRoleStatementText(connectorId, REAL_VALUES.roleUser);

        expect(resolved.text).toBe(expected);
        expect(shouldShowCopyButton(resolved)).toBe(true);
      }
    }
  });
});

describe('resolveHelpSql — illustration mode (no values supplied)', () => {
  it('returns mode "illustration" and never shows a copy button, for every sql step x connector', () => {
    for (const step of SQL_STEPS) {
      for (const connectorId of HELP_STEP_CONNECTORS[step]) {
        const resolved = resolveHelpSql(step, connectorId, undefined);
        expect(resolved.mode).toBe('illustration');
        expect(shouldShowCopyButton(resolved)).toBe(false);
      }
    }
  });

  it('illustration text is never identical to real text built from distinct real values', () => {
    for (const step of SQL_STEPS) {
      for (const connectorId of HELP_STEP_CONNECTORS[step]) {
        const illustration = resolveHelpSql(step, connectorId, undefined);
        const real = resolveHelpSql(step, connectorId, REAL_VALUES);
        if (illustration.mode !== 'illustration' || real.mode !== 'real') {
          throw new Error('expected illustration/real modes');
        }
        expect(illustration.text).not.toBe(real.text);
      }
    }
  });
});

describe('resolveHelpSql — steps with no sql at all', () => {
  it('always returns mode "none", with or without values supplied', () => {
    for (const step of NO_SQL_STEPS) {
      for (const connectorId of HELP_STEP_CONNECTORS[step]) {
        expect(resolveHelpSql(step, connectorId, undefined).mode).toBe('none');
        expect(resolveHelpSql(step, connectorId, REAL_VALUES).mode).toBe('none');
      }
    }
  });
});

describe('resolveHelpSql — unrecognized connector', () => {
  it('returns mode "none" regardless of values', () => {
    expect(resolveHelpSql('read-only-user', 'sqlite', undefined).mode).toBe('none');
    expect(resolveHelpSql('read-only-user', 'sqlite', REAL_VALUES).mode).toBe('none');
  });
});

describe('shouldShowCopyButton — invariant', () => {
  it('is true only for mode "real", for every mode this module can produce', () => {
    expect(shouldShowCopyButton({ mode: 'none' })).toBe(false);
    expect(shouldShowCopyButton({ mode: 'unavailable' })).toBe(false);
    expect(shouldShowCopyButton({ mode: 'invalid', message: 'x' })).toBe(false);
    expect(shouldShowCopyButton({ mode: 'illustration', text: 'x' })).toBe(false);
    expect(shouldShowCopyButton({ mode: 'real', text: 'x' })).toBe(true);
  });
});
