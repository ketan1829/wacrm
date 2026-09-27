// ============================================================
// WACRM Broadcast V1.1 — Audience Resolution & Multi-Condition Filtering
//
// Single source of truth for audience calculation between frontend
// wizard steps (estimated reach counter) and server-side broadcast
// delivery (batch sending & scheduled cron runs).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeKey } from '@/lib/contacts/dedupe';
import type { Contact } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldCondition {
  id: string;
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface CustomFieldFilterConfig {
  conjunction: 'AND' | 'OR';
  conditions: CustomFieldCondition[];
}

export type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';

export interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  /** Legacy single-condition filter for backward compatibility */
  customField?: {
    fieldId: string;
    operator: CustomFieldOperator;
    value: string;
  };
  /** V1.1 multi-condition custom field filter */
  customFieldFilter?: CustomFieldFilterConfig;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

/**
 * Normalizes an audience config into a canonical CustomFieldFilterConfig.
 * Preserves legacy single-field `customField` objects while supporting
 * V1.1 multi-condition configurations.
 */
export function normalizeFilterConfig(
  audience: AudienceConfig,
): CustomFieldFilterConfig | null {
  if (
    audience.customFieldFilter &&
    Array.isArray(audience.customFieldFilter.conditions) &&
    audience.customFieldFilter.conditions.length > 0
  ) {
    return {
      conjunction: audience.customFieldFilter.conjunction === 'OR' ? 'OR' : 'AND',
      conditions: audience.customFieldFilter.conditions.filter(
        (c) => c && c.fieldId && c.value.trim().length > 0,
      ),
    };
  }

  if (
    audience.customField &&
    audience.customField.fieldId &&
    audience.customField.value.trim().length > 0
  ) {
    return {
      conjunction: 'AND',
      conditions: [
        {
          id: 'legacy-filter-0',
          fieldId: audience.customField.fieldId,
          operator: audience.customField.operator || 'is',
          value: audience.customField.value.trim(),
        },
      ],
    };
  }

  return null;
}

/**
 * Executes multi-condition custom field filtering against `contact_custom_values`.
 * Supports AND (intersection of matching contact sets) and OR (union of matching contact sets).
 */
export async function resolveCustomFieldContactIds(
  supabase: SupabaseClient,
  filter: CustomFieldFilterConfig,
): Promise<Set<string>> {
  const activeConditions = filter.conditions.filter(
    (c) => c.fieldId && c.value.trim().length > 0,
  );

  if (activeConditions.length === 0) {
    return new Set<string>();
  }

  let accumulatedIds: Set<string> | null = null;

  for (const condition of activeConditions) {
    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', condition.fieldId);

    const val = condition.value.trim();
    if (condition.operator === 'is') {
      query = query.eq('value', val);
    } else if (condition.operator === 'is_not') {
      query = query.neq('value', val);
    } else if (condition.operator === 'contains') {
      query = query.ilike('value', `%${val}%`);
    }

    const { data: matches, error } = await query;
    if (error) {
      throw new Error(`Custom field query failed: ${error.message}`);
    }

    const currentSet = new Set<string>((matches ?? []).map((m) => m.contact_id));

    if (accumulatedIds === null) {
      accumulatedIds = currentSet;
    } else if (filter.conjunction === 'AND') {
      const intersected = new Set<string>();
      for (const id of currentSet) {
        if (accumulatedIds.has(id)) {
          intersected.add(id);
        }
      }
      accumulatedIds = intersected;
      if (accumulatedIds.size === 0) {
        break; // Early exit on empty intersection
      }
    } else {
      // OR conjunction
      for (const id of currentSet) {
        accumulatedIds.add(id);
      }
    }
  }

  return accumulatedIds ?? new Set<string>();
}

/**
 * Resolves contacts matching CSV entries, deduplicating by normalized phone
 * number and batch-inserting missing contacts into the account.
 */
export async function upsertCsvContacts(
  supabase: SupabaseClient,
  accountId: string,
  userId: string,
  csvRows: { phone: string; name?: string }[],
): Promise<Contact[]> {
  if (csvRows.length === 0) return [];

  const uniqueByKey = new Map<string, { phone: string; name?: string }>();
  for (const row of csvRows) {
    const key = normalizeKey(row.phone);
    if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
  }
  const keys = [...uniqueByKey.keys()];
  if (keys.length === 0) return [];

  // Look up existing contacts in this account
  const { data: existing, error: lookupErr } = await supabase
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .in('phone_normalized', keys);

  if (lookupErr) {
    throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
  }

  const byKey = new Map<string, Contact>();
  for (const c of (existing ?? []) as Contact[]) {
    const key = normalizeKey(c.phone ?? '');
    if (key) byKey.set(key, c);
  }

  // Insert missing contacts in chunks of 200
  const missing = keys
    .filter((k) => !byKey.has(k))
    .map((k) => uniqueByKey.get(k)!)
    .map((row) => ({
      user_id: userId,
      account_id: accountId,
      phone: row.phone,
      name: row.name ?? null,
    }));

  const INSERT_CHUNK = 200;
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK);
    const { data: inserted, error: insertErr } = await supabase
      .from('contacts')
      .insert(chunk)
      .select();
    if (insertErr) {
      throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
    }
    for (const c of (inserted ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }
  }

  return keys
    .map((k) => byKey.get(k))
    .filter((c): c is Contact => Boolean(c));
}

/**
 * Resolves the full Contact list for a given AudienceConfig.
 * Single source of truth used by wizard preview and broadcast sender.
 */
export async function resolveAudience(
  supabase: SupabaseClient,
  accountId: string,
  audience: AudienceConfig,
  currentUserId?: string,
): Promise<Contact[]> {
  let contacts: Contact[] = [];

  if (audience.type === 'all') {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', accountId);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    contacts = data ?? [];
  } else if (
    audience.type === 'tags' &&
    audience.tagIds &&
    audience.tagIds.length > 0
  ) {
    const { data: contactTags, error: tagError } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.tagIds);

    if (tagError) {
      throw new Error(`Failed to fetch contact tags: ${tagError.message}`);
    }

    if (contactTags && contactTags.length > 0) {
      const uniqueContactIds = [
        ...new Set(contactTags.map((ct) => ct.contact_id)),
      ];
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .in('id', uniqueContactIds);
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    }
  } else if (audience.type === 'custom_field') {
    const filter = normalizeFilterConfig(audience);
    if (filter && filter.conditions.length > 0) {
      const contactIds = await resolveCustomFieldContactIds(supabase, filter);
      if (contactIds.size > 0) {
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .eq('account_id', accountId)
          .in('id', [...contactIds]);
        if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
        contacts = data ?? [];
      }
    }
  } else if (audience.type === 'csv' && audience.csvContacts) {
    if (currentUserId) {
      contacts = await upsertCsvContacts(
        supabase,
        accountId,
        currentUserId,
        audience.csvContacts,
      );
    }
  }

  // Apply exclude tags (across all non-CSV audiences)
  if (
    audience.type !== 'csv' &&
    audience.excludeTagIds &&
    audience.excludeTagIds.length > 0
  ) {
    const { data: excludeRows } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.excludeTagIds);

    const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
    contacts = contacts.filter((c) => !excludedIds.has(c.id));
  }

  return contacts;
}

/**
 * Calculates the audience reach count for UI indicators without fetching
 * entire contact objects whenever possible.
 */
export async function resolveAudienceCount(
  supabase: SupabaseClient,
  accountId: string,
  audience: AudienceConfig,
): Promise<number> {
  if (audience.type === 'csv') {
    return audience.csvContacts?.length ?? 0;
  }

  // Determine exclude contact IDs
  let excludeSet: Set<string> | null = null;
  if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
    const { data: excludeRows } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.excludeTagIds);
    excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
  }

  if (audience.type === 'all') {
    if (!excludeSet || excludeSet.size === 0) {
      const { count } = await supabase
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId);
      return count ?? 0;
    }
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('account_id', accountId);
    return (data ?? []).filter((c) => !excludeSet!.has(c.id)).length;
  }

  if (audience.type === 'tags') {
    if (!audience.tagIds || audience.tagIds.length === 0) return 0;

    const { data: contactTags } = await supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', audience.tagIds);

    const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
    if (excludeSet && excludeSet.size > 0) {
      return [...uniqueIds].filter((id) => !excludeSet!.has(id)).length;
    }
    return uniqueIds.size;
  }

  if (audience.type === 'custom_field') {
    const filter = normalizeFilterConfig(audience);
    if (!filter || filter.conditions.length === 0) return 0;

    const matchingIds = await resolveCustomFieldContactIds(supabase, filter);
    if (matchingIds.size === 0) return 0;

    // Filter to ensure contacts belong to this account
    const { data: accountContacts } = await supabase
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .in('id', [...matchingIds]);

    const validIds = new Set((accountContacts ?? []).map((c) => c.id));
    if (excludeSet && excludeSet.size > 0) {
      return [...validIds].filter((id) => !excludeSet!.has(id)).length;
    }
    return validIds.size;
  }

  return 0;
}

export type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
export async function fetchCustomValueIndex(
  supabase: SupabaseClient,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}
