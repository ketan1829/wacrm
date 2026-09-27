/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import {
  parseGenericCsv,
  autoDetectColumnMapping,
  validateCustomFieldValue,
  preflightImportAnalysis,
  executeContactImport,
  type ColumnMapping,
} from './import-engine';
import type { CustomField } from '@/types';

describe('Contact Importer Engine', () => {
  const mockCustomFields: CustomField[] = [
    {
      id: 'cf-clinic',
      account_id: 'acc-1',
      user_id: 'usr-1',
      field_name: 'Clinic Name',
      field_type: 'text',
      created_at: new Date().toISOString(),
    },
    {
      id: 'cf-rating',
      account_id: 'acc-1',
      user_id: 'usr-1',
      field_name: 'Rating',
      field_type: 'number',
      created_at: new Date().toISOString(),
    },
    {
      id: 'cf-active',
      account_id: 'acc-1',
      user_id: 'usr-1',
      field_name: 'Is Verified',
      field_type: 'boolean',
      created_at: new Date().toISOString(),
    },
    {
      id: 'cf-date',
      account_id: 'acc-1',
      user_id: 'usr-1',
      field_name: 'Appointment Date',
      field_type: 'date',
      created_at: new Date().toISOString(),
    },
  ];

  describe('1. Generic CSV Parser', () => {
    it('parses standard comma-separated values and trims cells', () => {
      const csv = `phone,name,company\n+15551234567,Alice,Acme Corp\n+15559876543,Bob,Beta LLC`;
      const { headers, rows } = parseGenericCsv(csv);
      expect(headers).toEqual(['phone', 'name', 'company']);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        phone: '+15551234567',
        name: 'Alice',
        company: 'Acme Corp',
      });
      expect(rows[1]).toEqual({
        phone: '+15559876543',
        name: 'Bob',
        company: 'Beta LLC',
      });
    });

    it('handles quoted cells with commas and escaped quotes', () => {
      const csv = `Phone,Name,"Clinic, Location",Notes\n+15551111,"Dr. John ""Jack"" Smith","Dental Clinic, NY","A, B, and C"`;
      const { headers, rows } = parseGenericCsv(csv);
      expect(headers).toEqual(['Phone', 'Name', 'Clinic, Location', 'Notes']);
      expect(rows).toHaveLength(1);
      expect(rows[0]['Name']).toBe('Dr. John "Jack" Smith');
      expect(rows[0]['Clinic, Location']).toBe('Dental Clinic, NY');
      expect(rows[0]['Notes']).toBe('A, B, and C');
    });

    it('returns empty headers and rows for empty text', () => {
      expect(parseGenericCsv('')).toEqual({ headers: [], rows: [] });
      expect(parseGenericCsv('   \n  \n')).toEqual({ headers: [], rows: [] });
    });
  });

  describe('2. Column Auto-Mapping Heuristics', () => {
    it('correctly maps standard fields and custom fields by name', () => {
      const headers = [
        'Phone Number',
        'Contact Name',
        'Email Address',
        'Company',
        'Tags',
        'Clinic Name',
        'Rating',
        'Unknown Column',
      ];
      const mapping = autoDetectColumnMapping(headers, mockCustomFields);

      expect(mapping['Phone Number']).toEqual({ type: 'standard', field: 'phone' });
      expect(mapping['Contact Name']).toEqual({ type: 'standard', field: 'name' });
      expect(mapping['Email Address']).toEqual({ type: 'standard', field: 'email' });
      expect(mapping['Company']).toEqual({ type: 'standard', field: 'company' });
      expect(mapping['Tags']).toEqual({ type: 'standard', field: 'tags' });
      expect(mapping['Clinic Name']).toEqual({
        type: 'custom',
        customFieldId: 'cf-clinic',
        fieldName: 'Clinic Name',
        fieldType: 'text',
      });
      expect(mapping['Rating']).toEqual({
        type: 'custom',
        customFieldId: 'cf-rating',
        fieldName: 'Rating',
        fieldType: 'number',
      });
      expect(mapping['Unknown Column']).toEqual({ type: 'ignore' });
    });
  });

  describe('3. Custom Field Type Validation', () => {
    it('validates number fields and rejects non-numeric input', () => {
      expect(validateCustomFieldValue('4.8', 'number')).toEqual({
        valid: true,
        normalizedValue: '4.8',
      });
      expect(validateCustomFieldValue('abc', 'number')).toEqual({
        valid: false,
        error: 'Value "abc" is not a valid number',
        normalizedValue: 'abc',
      });
    });

    it('validates boolean fields and normalizes variants', () => {
      expect(validateCustomFieldValue('true', 'boolean')).toEqual({
        valid: true,
        normalizedValue: 'true',
      });
      expect(validateCustomFieldValue('yes', 'boolean')).toEqual({
        valid: true,
        normalizedValue: 'true',
      });
      expect(validateCustomFieldValue('0', 'boolean')).toEqual({
        valid: true,
        normalizedValue: 'false',
      });
      expect(validateCustomFieldValue('maybe', 'boolean')).toEqual({
        valid: false,
        error: 'Value "maybe" is not a valid boolean (expected true/false, yes/no, 1/0)',
        normalizedValue: 'maybe',
      });
    });

    it('validates date fields', () => {
      expect(validateCustomFieldValue('2026-10-15', 'date').valid).toBe(true);
      expect(validateCustomFieldValue('not-a-date', 'date').valid).toBe(false);
    });

    it('treats blank cells as valid and non-mutating', () => {
      expect(validateCustomFieldValue('   ', 'number')).toEqual({
        valid: true,
        normalizedValue: '',
      });
      expect(validateCustomFieldValue('', 'boolean')).toEqual({
        valid: true,
        normalizedValue: '',
      });
    });
  });

  describe('4. Pre-Flight Analysis', () => {
    const mapping: ColumnMapping = {
      phone: { type: 'standard', field: 'phone' },
      name: { type: 'standard', field: 'name' },
      rating: {
        type: 'custom',
        customFieldId: 'cf-rating',
        fieldName: 'Rating',
        fieldType: 'number',
      },
    };

    const existingContacts = [
      { id: 'c1', phone: '+15551111111', name: 'Existing One' },
      { id: 'c2', phone: '+15552222222', name: 'Existing Two' },
    ];

    it('analyzes update mode: distinguishes matched vs unmatched vs errors', () => {
      const rows = [
        { phone: '+15551111111', name: 'Updated One', rating: '4.5' },
        { phone: '+15553333333', name: 'New Person', rating: '5.0' }, // unmatched
        { phone: '+15551111111', name: 'Duplicate Row', rating: '3.0' }, // in-file dupe
        { phone: '+15552222222', name: 'Bad Rating', rating: 'invalid-number' },
      ];

      const res = preflightImportAnalysis({
        rows,
        mapping,
        mode: 'update',
        existingContacts,
        customFields: mockCustomFields,
      });

      expect(res.totalRows).toBe(4);
      expect(res.matchedCount).toBe(2); // row 0 and row 3
      expect(res.unmatchedCount).toBe(1); // row 1
      expect(res.duplicateCount).toBe(1); // row 2
      expect(res.validationErrorCount).toBe(1); // row 3 bad rating
      expect(res.fieldErrors[0].error).toContain('not a valid number');
    });
  });

  describe('5. Import Execution & Custom Field Merging', () => {
    function createMockSupabase(initialContacts: any[] = [], initialCustomValues: any[] = []) {
      const contactsDb = [...initialContacts];
      const customValuesDb = [...initialCustomValues];

      const client = {
        contactsDb,
        customValuesDb,
        from: (table: string) => {
          let inFilterValues: any[] = [];
          const eqFilters: Record<string, any> = {};

          const builder: any = {
            select: vi.fn(() => {
              return builder;
            }),
            eq: vi.fn((col: string, val: any) => {
              eqFilters[col] = val;
              return builder;
            }),
            in: vi.fn((col: string, vals: any[]) => {
              if (col === 'phone_normalized') inFilterValues = vals;
              return builder;
            }),
            like: vi.fn(() => Promise.resolve({ data: [], error: null })),
            single: vi.fn(() => Promise.resolve({ data: null, error: null })),
            then: (resolve: any) => {
              if (table === 'contacts') {
                const res = contactsDb.filter((c) => {
                  if (eqFilters.account_id && c.account_id !== eqFilters.account_id) return false;
                  if (inFilterValues.length > 0) {
                    const norm = c.phone.replace(/\D/g, '');
                    return inFilterValues.includes(norm);
                  }
                  return true;
                });
                return resolve({ data: res, error: null });
              }
              if (table === 'contact_custom_values') {
                return resolve({ data: customValuesDb, error: null });
              }
              return resolve({ data: [], error: null });
            },
            update: vi.fn((payload: any) => ({
              eq: vi.fn((idCol: string, idVal: string) => ({
                eq: vi.fn((accCol: string, accVal: string) => {
                  const target = contactsDb.find(
                    (c) => c.id === idVal && c.account_id === accVal
                  );
                  if (target) {
                    Object.assign(target, payload);
                  }
                  return Promise.resolve({ error: null });
                }),
              })),
            })),
            insert: vi.fn((rows: any[]) => {
              const inserted = rows.map((r, i) => {
                const newRow = {
                  id: `new-contact-${contactsDb.length + i + 1}`,
                  phone_normalized: r.phone.replace(/\D/g, ''),
                  ...r,
                };
                contactsDb.push(newRow);
                return newRow;
              });
              return {
                select: vi.fn(() => Promise.resolve({ data: inserted, error: null })),
              };
            }),
            upsert: vi.fn((rows: any[]) => {
              for (const r of rows) {
                const existingIdx = customValuesDb.findIndex(
                  (cv) =>
                    cv.contact_id === r.contact_id &&
                    cv.custom_field_id === r.custom_field_id
                );
                if (existingIdx >= 0) {
                  customValuesDb[existingIdx].value = r.value;
                } else {
                  customValuesDb.push({ id: `cv-${customValuesDb.length + 1}`, ...r });
                }
              }
              return Promise.resolve({ error: null });
            }),
          };
          return builder;
        },
      };

      return client;
    }

    it('Scenario 1: Existing contact update — updates standard fields & merges custom field with same contact ID', async () => {
      const mockDb = createMockSupabase([
        {
          id: 'contact-1',
          account_id: 'acc-1',
          user_id: 'usr-1',
          phone: '+15551234567',
          name: 'Old Name',
          company: 'Old Co',
        },
      ]);

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        name: { type: 'standard', field: 'name' },
        clinic: {
          type: 'custom',
          customFieldId: 'cf-clinic',
          fieldName: 'Clinic Name',
          fieldType: 'text',
        },
      };

      const rows = [
        {
          phone: '+1 555 123 4567',
          name: 'New Name',
          clinic: 'Dental Clinic',
        },
      ];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'update',
        customFields: mockCustomFields,
      });

      expect(res.updated).toBe(1);
      expect(res.imported).toBe(0);
      expect(res.unmatched).toBe(0);

      // Verify contact was updated, not re-created
      const updatedContact = mockDb.contactsDb.find((c) => c.id === 'contact-1');
      expect(updatedContact?.name).toBe('New Name');
      expect(updatedContact?.company).toBe('Old Co'); // preserved

      // Verify custom field was inserted
      const cv = mockDb.customValuesDb.find(
        (v) => v.contact_id === 'contact-1' && v.custom_field_id === 'cf-clinic'
      );
      expect(cv?.value).toBe('Dental Clinic');
    });

    it('Scenario 2: Custom field merge — existing fields A+B + incoming field C = A+B+C', async () => {
      const mockDb = createMockSupabase(
        [
          {
            id: 'contact-1',
            account_id: 'acc-1',
            phone: '+15551234567',
          },
        ],
        [
          { contact_id: 'contact-1', custom_field_id: 'cf-clinic', value: 'Dentaland' },
          { contact_id: 'contact-1', custom_field_id: 'cf-rating', value: '4.8' },
        ]
      );

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        is_verified: {
          type: 'custom',
          customFieldId: 'cf-active',
          fieldName: 'Is Verified',
          fieldType: 'boolean',
        },
      };

      const rows = [{ phone: '+15551234567', is_verified: 'true' }];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'update',
        customFields: mockCustomFields,
      });

      expect(res.updated).toBe(1);

      // Verify fields A (clinic) and B (rating) are STILL intact!
      const clinicVal = mockDb.customValuesDb.find(
        (v) => v.contact_id === 'contact-1' && v.custom_field_id === 'cf-clinic'
      );
      const ratingVal = mockDb.customValuesDb.find(
        (v) => v.contact_id === 'contact-1' && v.custom_field_id === 'cf-rating'
      );
      const activeVal = mockDb.customValuesDb.find(
        (v) => v.contact_id === 'contact-1' && v.custom_field_id === 'cf-active'
      );

      expect(clinicVal?.value).toBe('Dentaland');
      expect(ratingVal?.value).toBe('4.8');
      expect(activeVal?.value).toBe('true');
    });

    it('Scenario 3: Existing field update — existing field A + incoming new value = updated A', async () => {
      const mockDb = createMockSupabase(
        [
          {
            id: 'contact-1',
            account_id: 'acc-1',
            phone: '+15551234567',
          },
        ],
        [{ contact_id: 'contact-1', custom_field_id: 'cf-rating', value: '4.2' }]
      );

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        rating: {
          type: 'custom',
          customFieldId: 'cf-rating',
          fieldName: 'Rating',
          fieldType: 'number',
        },
      };

      const rows = [{ phone: '+15551234567', rating: '4.9' }];

      await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'update',
        customFields: mockCustomFields,
      });

      const ratingVal = mockDb.customValuesDb.find(
        (v) => v.contact_id === 'contact-1' && v.custom_field_id === 'cf-rating'
      );
      expect(ratingVal?.value).toBe('4.9');
    });

    it('Scenario 4: Blank field preservation — existing A + blank incoming A = existing A preserved', async () => {
      const mockDb = createMockSupabase(
        [
          {
            id: 'contact-1',
            account_id: 'acc-1',
            phone: '+15551234567',
            name: 'Original Name',
          },
        ],
        [{ contact_id: 'contact-1', custom_field_id: 'cf-clinic', value: 'Dentaland' }]
      );

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        name: { type: 'standard', field: 'name' },
        clinic: {
          type: 'custom',
          customFieldId: 'cf-clinic',
          fieldName: 'Clinic Name',
          fieldType: 'text',
        },
      };

      // Blank name and blank clinic
      const rows = [{ phone: '+15551234567', name: '', clinic: '   ' }];

      await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'update',
        customFields: mockCustomFields,
      });

      const contact = mockDb.contactsDb.find((c) => c.id === 'contact-1');
      expect(contact?.name).toBe('Original Name'); // Not wiped!

      const clinicVal = mockDb.customValuesDb.find(
        (v) => v.contact_id === 'contact-1' && v.custom_field_id === 'cf-clinic'
      );
      expect(clinicVal?.value).toBe('Dentaland'); // Not wiped!
    });

    it('Scenario 5: Unmatched contact in Update mode — unknown phone = no contact created', async () => {
      const mockDb = createMockSupabase([
        {
          id: 'contact-1',
          account_id: 'acc-1',
          phone: '+15551234567',
        },
      ]);

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        name: { type: 'standard', field: 'name' },
      };

      const rows = [{ phone: '+15559999999', name: 'Unknown Person' }];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'update',
        customFields: mockCustomFields,
      });

      expect(res.updated).toBe(0);
      expect(res.imported).toBe(0);
      expect(res.unmatched).toBe(1);
      expect(res.unmatchedDetails).toHaveLength(1);
      expect(res.unmatchedDetails[0].phone).toBe('+15559999999');
      expect(mockDb.contactsDb).toHaveLength(1); // 0 new contacts created!
    });

    it('Scenario 6: Create + update mode — existing phone updates, new phone creates', async () => {
      const mockDb = createMockSupabase([
        {
          id: 'contact-1',
          account_id: 'acc-1',
          phone: '+15551234567',
          name: 'Existing Guy',
        },
      ]);

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        name: { type: 'standard', field: 'name' },
        clinic: {
          type: 'custom',
          customFieldId: 'cf-clinic',
          fieldName: 'Clinic Name',
          fieldType: 'text',
        },
      };

      const rows = [
        { phone: '+15551234567', name: 'Updated Guy', clinic: 'Smile Care' },
        { phone: '+15557777777', name: 'Brand New', clinic: 'New Clinic' },
      ];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'create_update',
        customFields: mockCustomFields,
      });

      expect(res.updated).toBe(1);
      expect(res.imported).toBe(1);
      expect(res.unmatched).toBe(0);
      expect(mockDb.contactsDb).toHaveLength(2);

      const existing = mockDb.contactsDb.find((c) => c.id === 'contact-1');
      expect(existing?.name).toBe('Updated Guy');

      const brandNew = mockDb.contactsDb.find((c) => c.phone === '+15557777777');
      expect(brandNew?.name).toBe('Brand New');
    });

    it('Scenario 7: Tenant isolation — contact in another account is never updated', async () => {
      const mockDb = createMockSupabase([
        {
          id: 'contact-other-account',
          account_id: 'acc-other', // DIFFERENT ACCOUNT
          phone: '+15551234567',
          name: 'Other Account Person',
        },
      ]);

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        name: { type: 'standard', field: 'name' },
      };

      const rows = [{ phone: '+15551234567', name: 'Hacked Name' }];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1', // CALLER IS ACC-1
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'update',
        customFields: mockCustomFields,
      });

      // Must be reported as unmatched in acc-1
      expect(res.unmatched).toBe(1);
      expect(res.updated).toBe(0);

      // Other account's contact must remain completely untouched
      const other = mockDb.contactsDb.find((c) => c.id === 'contact-other-account');
      expect(other?.name).toBe('Other Account Person');
    });

    it('Scenario 8: Duplicate spreadsheet row is detected and skipped', async () => {
      const mockDb = createMockSupabase();
      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        name: { type: 'standard', field: 'name' },
      };

      const rows = [
        { phone: '+15551112222', name: 'First' },
        { phone: '+1 (555) 111-2222', name: 'Second Dupe' },
      ];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'create',
        customFields: mockCustomFields,
      });

      expect(res.imported).toBe(1);
      expect(res.skipped).toBe(1);
    });

    it('Scenario 9: Invalid custom field value is rejected with clear error', async () => {
      const mockDb = createMockSupabase();
      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        rating: {
          type: 'custom',
          customFieldId: 'cf-rating',
          fieldName: 'Rating',
          fieldType: 'number',
        },
      };

      const rows = [{ phone: '+15551234567', rating: 'invalid-rating' }];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'create',
        customFields: mockCustomFields,
      });

      expect(res.failed).toBe(1);
      expect(res.failedDetails[0].reason).toContain('Rating: Value "invalid-rating" is not a valid number');
    });

    it('Scenario 10: Regression — Create-only mode skips existing contacts and inserts new ones', async () => {
      const mockDb = createMockSupabase([
        {
          id: 'contact-existing',
          account_id: 'acc-1',
          phone: '+15551234567',
          name: 'Already There',
        },
      ]);

      const mapping: ColumnMapping = {
        phone: { type: 'standard', field: 'phone' },
        name: { type: 'standard', field: 'name' },
      };

      const rows = [
        { phone: '+15551234567', name: 'Should Be Skipped' },
        { phone: '+15558888888', name: 'Should Be Inserted' },
      ];

      const res = await executeContactImport({
        supabase: mockDb as any,
        accountId: 'acc-1',
        userId: 'usr-1',
        rows,
        mapping,
        mode: 'create',
        customFields: mockCustomFields,
      });

      expect(res.imported).toBe(1);
      expect(res.skipped).toBe(1);
      expect(res.updated).toBe(0);

      // Existing contact is NOT updated in create mode
      const existing = mockDb.contactsDb.find((c) => c.id === 'contact-existing');
      expect(existing?.name).toBe('Already There');
    });
  });
});
