import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  normalizeFilterConfig,
  resolveCustomFieldContactIds,
  resolveAudience,
  resolveAudienceCount,
  type AudienceConfig,
  type CustomFieldFilterConfig,
} from './broadcast-audience';

describe('normalizeFilterConfig', () => {
  it('normalizes legacy single customField object', () => {
    const audience: AudienceConfig = {
      type: 'custom_field',
      customField: {
        fieldId: 'field-123',
        operator: 'is',
        value: 'Implants',
      },
    };
    const normalized = normalizeFilterConfig(audience);
    expect(normalized).toEqual({
      conjunction: 'AND',
      conditions: [
        {
          id: 'legacy-filter-0',
          fieldId: 'field-123',
          operator: 'is',
          value: 'Implants',
        },
      ],
    });
  });

  it('normalizes V1.1 multi-condition customFieldFilter', () => {
    const filterConfig: CustomFieldFilterConfig = {
      conjunction: 'OR',
      conditions: [
        { id: 'c1', fieldId: 'f1', operator: 'is', value: 'Implants' },
        { id: 'c2', fieldId: 'f1', operator: 'is', value: 'Aligners' },
      ],
    };
    const audience: AudienceConfig = {
      type: 'custom_field',
      customFieldFilter: filterConfig,
    };
    const normalized = normalizeFilterConfig(audience);
    expect(normalized).toEqual({
      conjunction: 'OR',
      conditions: [
        { id: 'c1', fieldId: 'f1', operator: 'is', value: 'Implants' },
        { id: 'c2', fieldId: 'f1', operator: 'is', value: 'Aligners' },
      ],
    });
  });

  it('filters out empty or blank conditions', () => {
    const audience: AudienceConfig = {
      type: 'custom_field',
      customFieldFilter: {
        conjunction: 'AND',
        conditions: [
          { id: 'c1', fieldId: 'f1', operator: 'is', value: 'Google' },
          { id: 'c2', fieldId: 'f2', operator: 'is', value: '   ' },
        ],
      },
    };
    const normalized = normalizeFilterConfig(audience);
    expect(normalized?.conditions).toHaveLength(1);
    expect(normalized?.conditions[0].fieldId).toBe('f1');
  });

  it('returns null when no conditions exist', () => {
    const audience: AudienceConfig = { type: 'custom_field' };
    expect(normalizeFilterConfig(audience)).toBeNull();
  });
});

describe('resolveCustomFieldContactIds', () => {
  it('resolves 1 condition with operator "is"', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((col: string) => {
          if (col === 'value') {
            return Promise.resolve({
              data: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }],
              error: null,
            });
          }
          return mockSupabase.from();
        }),
      }),
    };

    const filter: CustomFieldFilterConfig = {
      conjunction: 'AND',
      conditions: [{ id: '1', fieldId: 'f1', operator: 'is', value: 'Active' }],
    };

    const ids = await resolveCustomFieldContactIds(mockSupabase as unknown as SupabaseClient, filter);
    expect(ids).toEqual(new Set(['c-1', 'c-2']));
  });

  it('intersects matches for multiple conditions with AND conjunction', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        let fieldId = '';
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((col: string, val: string) => {
            if (col === 'custom_field_id') fieldId = val;
            if (col === 'value') {
              if (fieldId === 'f1') {
                return Promise.resolve({
                  data: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }],
                  error: null,
                });
              } else if (fieldId === 'f2') {
                return Promise.resolve({
                  data: [{ contact_id: 'c-2' }, { contact_id: 'c-3' }],
                  error: null,
                });
              }
            }
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockImplementation((col2: string) => {
                if (col2 === 'value') {
                  if (fieldId === 'f1') {
                    return Promise.resolve({
                      data: [{ contact_id: 'c-1' }, { contact_id: 'c-2' }],
                      error: null,
                    });
                  } else {
                    return Promise.resolve({
                      data: [{ contact_id: 'c-2' }, { contact_id: 'c-3' }],
                      error: null,
                    });
                  }
                }
              }),
            };
          }),
        };
      }),
    };

    const filter: CustomFieldFilterConfig = {
      conjunction: 'AND',
      conditions: [
        { id: '1', fieldId: 'f1', operator: 'is', value: 'Implants' },
        { id: '2', fieldId: 'f2', operator: 'is', value: 'Google' },
      ],
    };

    const ids = await resolveCustomFieldContactIds(mockSupabase as unknown as SupabaseClient, filter);
    // Intersection of ['c-1', 'c-2'] and ['c-2', 'c-3'] is ['c-2']
    expect(ids).toEqual(new Set(['c-2']));
  });

  it('unions matches for multiple conditions with OR conjunction', async () => {
    const mockSupabase = {
      from: vi.fn().mockImplementation(() => {
        let fieldId = '';
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((col: string, val: string) => {
            if (col === 'custom_field_id') fieldId = val;
            if (col === 'value') {
              if (fieldId === 'f1') {
                return Promise.resolve({
                  data: [{ contact_id: 'c-1' }],
                  error: null,
                });
              } else if (fieldId === 'f2') {
                return Promise.resolve({
                  data: [{ contact_id: 'c-2' }],
                  error: null,
                });
              }
            }
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockImplementation((col2: string) => {
                if (col2 === 'value') {
                  if (fieldId === 'f1') {
                    return Promise.resolve({
                      data: [{ contact_id: 'c-1' }],
                      error: null,
                    });
                  } else {
                    return Promise.resolve({
                      data: [{ contact_id: 'c-2' }],
                      error: null,
                    });
                  }
                }
              }),
            };
          }),
        };
      }),
    };

    const filter: CustomFieldFilterConfig = {
      conjunction: 'OR',
      conditions: [
        { id: '1', fieldId: 'f1', operator: 'is', value: 'Implants' },
        { id: '2', fieldId: 'f2', operator: 'is', value: 'Aligners' },
      ],
    };

    const ids = await resolveCustomFieldContactIds(mockSupabase as unknown as SupabaseClient, filter);
    // Union of ['c-1'] and ['c-2'] is ['c-1', 'c-2']
    expect(ids).toEqual(new Set(['c-1', 'c-2']));
  });

  it('returns empty set if no contacts match', async () => {
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((col: string) => {
          if (col === 'value') {
            return Promise.resolve({ data: [], error: null });
          }
          return mockSupabase.from();
        }),
      }),
    };

    const filter: CustomFieldFilterConfig = {
      conjunction: 'AND',
      conditions: [{ id: '1', fieldId: 'f1', operator: 'is', value: 'None' }],
    };

    const ids = await resolveCustomFieldContactIds(mockSupabase as unknown as SupabaseClient, filter);
    expect(ids.size).toBe(0);
  });
});

describe('resolveAudience & resolveAudienceCount', () => {
  it('applies exclude tags when resolving audience and counts matching contacts', async () => {
    const contactsData = [
      { id: 'c-1', name: 'Alice', phone: '+1234567890' },
      { id: 'c-2', name: 'Bob', phone: '+1234567891' },
    ];

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({ data: contactsData, error: null }),
          };
        }
        if (table === 'contact_tags') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [{ contact_id: 'c-2' }],
              error: null,
            }),
          };
        }
        return {};
      }),
    };

    const audience: AudienceConfig = {
      type: 'all',
      excludeTagIds: ['tag-excluded'],
    };

    const client = mockSupabase as unknown as SupabaseClient;
    const result = await resolveAudience(client, 'acc-1', audience);
    // Bob (c-2) has the excluded tag, so only Alice survives
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c-1');

    const count = await resolveAudienceCount(client, 'acc-1', audience);
    expect(count).toBe(1);
  });
});
