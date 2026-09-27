import { describe, it, expect } from 'vitest';
import {
  resolveVariables,
  validatePersonalization,
  filterContactsByMissingPolicy,
  renderTemplatePreview,
  type VariableMapping,
} from './broadcast-variables';
import type { Contact } from '@/types';

const mockContacts: Contact[] = [
  {
    id: 'c-1',
    user_id: 'u-1',
    account_id: 'a-1',
    name: 'Alice Smith',
    phone: '+14155550101',
    email: 'alice@example.com',
    company: 'Acme',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'c-2',
    user_id: 'u-1',
    account_id: 'a-1',
    name: '',
    phone: '+14155550102',
    email: undefined,
    company: undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

describe('resolveVariables', () => {
  it('resolves built-in contact fields and custom fields numerically by placeholder index', () => {
    const variables: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'name' },
      '2': { type: 'custom_field', value: 'field-treatment' },
      '10': { type: 'static', value: 'Special Offer' },
    };

    const customValues = new Map<string, string>([
      ['field-treatment', 'Dental Implants'],
    ]);

    const resolved = resolveVariables(variables, mockContacts[0], customValues);
    expect(resolved).toEqual(['Alice Smith', 'Dental Implants', 'Special Offer']);
  });

  it('applies fallback when contact value is missing and policy is fallback', () => {
    const variables: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'name', fallback: 'Valued Customer' },
      '2': { type: 'custom_field', value: 'field-treatment', fallback: 'your checkup' },
    };

    const resolved = resolveVariables(
      variables,
      mockContacts[1],
      new Map(),
      'fallback',
    );
    expect(resolved).toEqual(['Valued Customer', 'your checkup']);
  });

  it('applies empty string when missing and policy is blank without fallback', () => {
    const variables: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'name' },
    };

    const resolved = resolveVariables(variables, mockContacts[1], new Map(), 'blank');
    expect(resolved).toEqual(['']);
  });
});

describe('validatePersonalization', () => {
  it('identifies contacts missing required custom fields', () => {
    const placeholders = ['{{1}}', '{{2}}'];
    const variables: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'name' },
      '2': { type: 'custom_field', value: 'field-treatment' },
    };

    const customIndex = new Map<string, Map<string, string>>([
      ['c-1', new Map([['field-treatment', 'Implants']])],
      // c-2 has no custom value for field-treatment and empty name
    ]);

    const validation = validatePersonalization(
      mockContacts,
      placeholders,
      variables,
      customIndex,
    );

    expect(validation.totalContacts).toBe(2);
    expect(validation.validCount).toBe(1);
    expect(validation.missingCount).toBe(1);
    expect(validation.contactsWithMissing[0].contactId).toBe('c-2');
    expect(validation.missingPlaceholders).toContain('{{1}}');
    expect(validation.missingPlaceholders).toContain('{{2}}');
  });

  it('considers variable with fallback as not missing', () => {
    const placeholders = ['{{1}}'];
    const variables: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'name', fallback: 'Friend' },
    };

    const validation = validatePersonalization(
      mockContacts,
      placeholders,
      variables,
      new Map(),
    );

    expect(validation.missingCount).toBe(0);
    expect(validation.validCount).toBe(2);
  });
});

describe('filterContactsByMissingPolicy', () => {
  it('excludes contacts with missing values when policy is exclude', () => {
    const validation = {
      totalContacts: 2,
      validCount: 1,
      missingCount: 1,
      contactsWithMissing: [{ contactId: 'c-2', missingPlaceholders: ['{{1}}'] }],
      missingPlaceholders: ['{{1}}'],
    };

    const filtered = filterContactsByMissingPolicy(
      mockContacts,
      validation,
      'exclude',
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('c-1');
  });

  it('keeps all contacts when policy is blank or fallback', () => {
    const validation = {
      totalContacts: 2,
      validCount: 1,
      missingCount: 1,
      contactsWithMissing: [{ contactId: 'c-2', missingPlaceholders: ['{{1}}'] }],
      missingPlaceholders: ['{{1}}'],
    };

    const blankFiltered = filterContactsByMissingPolicy(
      mockContacts,
      validation,
      'blank',
    );
    expect(blankFiltered).toHaveLength(2);
  });
});

describe('renderTemplatePreview', () => {
  it('interpolates template placeholders for live preview', () => {
    const body = 'Hello {{1}}, your interest in {{2}} is confirmed!';
    const placeholders = ['{{1}}', '{{2}}'];
    const variables: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'name' },
      '2': { type: 'custom_field', value: 'field-treatment' },
    };
    const customValues = new Map([['field-treatment', 'Dental Implants']]);

    const rendered = renderTemplatePreview(
      body,
      placeholders,
      variables,
      mockContacts[0],
      customValues,
    );

    expect(rendered).toBe('Hello Alice Smith, your interest in Dental Implants is confirmed!');
  });
});
