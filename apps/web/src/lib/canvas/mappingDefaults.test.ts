import { describe, expect, it } from 'vitest';
import { defaultDestinationField } from './mappingDefaults';

describe('defaultDestinationField', () => {
  it('returns the same-named (case-insensitive) unmapped destination field when present', () => {
    expect(defaultDestinationField('email', ['full_name', 'Email'], [])).toBe('Email');
  });

  it('returns "" when the source field is empty', () => {
    expect(defaultDestinationField('', ['email'], [])).toBe('');
  });

  it('returns "" when no destination field matches the source field name', () => {
    expect(defaultDestinationField('email', ['full_name', 'customer_email'], [])).toBe('');
  });

  it('skips a same-named destination field already used by an existing entry', () => {
    expect(defaultDestinationField('email', ['email'], [{ from: 'contact_email', to: 'email' }])).toBe('');
  });

  it('new-table-mapping fix: defaults to the same name as the source field when destFields is empty (brand-new destination table)', () => {
    expect(defaultDestinationField('email', [], [])).toBe('email');
  });

  it('new-table-mapping fix: still yields "" for an empty destFields when that same name is already used by another entry', () => {
    expect(defaultDestinationField('email', [], [{ from: 'contact_email', to: 'email' }])).toBe('');
  });
});
