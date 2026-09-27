// ============================================================
// WACRM Broadcast V1.1 — Personalization & Missing Value Engine
//
// Shared variable resolution, live preview interpolation, and
// missing custom-field validation for broadcast messages.
// ============================================================

import type { Contact } from '@/types';

export type VariableType = 'static' | 'field' | 'custom_field';

export interface VariableMapping {
  type: VariableType;
  /**
   * For static: string text
   * For field: 'name' | 'phone' | 'email' | 'company'
   * For custom_field: custom_field_id UUID
   */
  value: string;
  /** Optional fallback value used when contact's custom/built-in value is missing */
  fallback?: string;
}

export type MissingValuePolicy = 'blank' | 'fallback' | 'exclude';

export interface ContactMissingDetail {
  contactId: string;
  missingPlaceholders: string[];
}

export interface PersonalizationValidationResult {
  totalContacts: number;
  validCount: number;
  missingCount: number;
  contactsWithMissing: ContactMissingDetail[];
  missingPlaceholders: string[];
}

/**
 * Resolves template variables for a single contact with fallback/blank support.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
  policy: MissingValuePolicy = 'blank',
  globalFallback: string = '',
): string[] {
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (!v) return '';

    if (v.type === 'static') {
      return v.value ?? '';
    }

    if (v.type === 'field') {
      const fieldMap: Record<string, string | null | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      const raw = fieldMap[v.value]?.trim();
      if (raw) return raw;

      if (policy === 'fallback') {
        return (v.fallback?.trim() || globalFallback || '').trim();
      }
      return v.fallback?.trim() ?? '';
    }

    // custom_field
    const rawVal = customValues?.get(v.value)?.trim();
    if (rawVal) return rawVal;

    if (policy === 'fallback') {
      return (v.fallback?.trim() || globalFallback || '').trim();
    }
    return v.fallback?.trim() ?? '';
  });
}

/**
 * Validates a list of contacts against mapped variables and detects any missing values.
 */
export function validatePersonalization(
  contacts: Contact[],
  placeholders: string[],
  variables: Record<string, VariableMapping>,
  customValueIndex: Map<string, Map<string, string>>,
): PersonalizationValidationResult {
  const contactsWithMissing: ContactMissingDetail[] = [];
  const missingPlaceholdersSet = new Set<string>();

  for (const contact of contacts) {
    const contactMissing: string[] = [];
    const contactCustoms = customValueIndex.get(contact.id);

    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        contactMissing.push(placeholder);
        missingPlaceholdersSet.add(placeholder);
        continue;
      }

      if (mapping.type === 'static') {
        continue;
      }

      if (mapping.type === 'field') {
        const fieldMap: Record<string, string | null | undefined> = {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          company: contact.company,
        };
        const val = fieldMap[mapping.value]?.trim();
        if (!val && !mapping.fallback?.trim()) {
          contactMissing.push(placeholder);
          missingPlaceholdersSet.add(placeholder);
        }
      } else if (mapping.type === 'custom_field') {
        const customVal = contactCustoms?.get(mapping.value)?.trim();
        if (!customVal && !mapping.fallback?.trim()) {
          contactMissing.push(placeholder);
          missingPlaceholdersSet.add(placeholder);
        }
      }
    }

    if (contactMissing.length > 0) {
      contactsWithMissing.push({
        contactId: contact.id,
        missingPlaceholders: contactMissing,
      });
    }
  }

  const missingCount = contactsWithMissing.length;
  const validCount = Math.max(0, contacts.length - missingCount);

  return {
    totalContacts: contacts.length,
    validCount,
    missingCount,
    contactsWithMissing,
    missingPlaceholders: Array.from(missingPlaceholdersSet).sort(),
  };
}

/**
 * Filters the contact list according to the missing value handling policy.
 * When policy === 'exclude', contacts with missing values are removed.
 */
export function filterContactsByMissingPolicy(
  contacts: Contact[],
  validationResult: PersonalizationValidationResult,
  policy: MissingValuePolicy,
): Contact[] {
  if (policy !== 'exclude') {
    return contacts;
  }

  const excludedIds = new Set(
    validationResult.contactsWithMissing.map((c) => c.contactId),
  );
  return contacts.filter((c) => !excludedIds.has(c.id));
}

/**
 * Interpolates template body text for live preview with real or sample contact data.
 */
export function renderTemplatePreview(
  bodyText: string,
  placeholders: string[],
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
  policy: MissingValuePolicy = 'blank',
  globalFallback: string = '',
): string {
  let result = bodyText;

  for (const placeholder of placeholders) {
    const key = placeholder.replace(/^\{\{|\}\}$/g, '');
    const mapping = variables[key];
    let replacement = placeholder;

    if (mapping) {
      if (mapping.type === 'static' && mapping.value) {
        replacement = mapping.value;
      } else if (mapping.type === 'field' && mapping.value) {
        const fieldMap: Record<string, string | null | undefined> = {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          company: contact.company,
        };
        const val = fieldMap[mapping.value]?.trim();
        if (val) {
          replacement = val;
        } else if (mapping.fallback?.trim()) {
          replacement = mapping.fallback.trim();
        } else if (policy === 'fallback' && globalFallback) {
          replacement = globalFallback.trim();
        } else {
          replacement = placeholder;
        }
      } else if (mapping.type === 'custom_field' && mapping.value) {
        const val = customValues?.get(mapping.value)?.trim();
        if (val) {
          replacement = val;
        } else if (mapping.fallback?.trim()) {
          replacement = mapping.fallback.trim();
        } else if (policy === 'fallback' && globalFallback) {
          replacement = globalFallback.trim();
        } else {
          replacement = placeholder;
        }
      }
    }

    result = result.replaceAll(placeholder, replacement);
  }

  return result;
}
