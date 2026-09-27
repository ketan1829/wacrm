import type { SupabaseClient } from '@supabase/supabase-js';
import type { CustomField } from '@/types';
import {
  normalizeKey,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import {
  normalizePhone,
  phonesMatch,
  isValidE164,
  parseInternationalPhone,
} from '@/lib/whatsapp/phone-utils';
import {
  resolveImportTagIds,
  assignImportedContactTags,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
import { parseTagCell } from '@/lib/contacts/parse-contact-csv';

export type ImportMode = 'create' | 'update' | 'create_update';

export type StandardContactField = 'phone' | 'name' | 'email' | 'company' | 'tags';

export type FieldMappingTarget =
  | { type: 'standard'; field: StandardContactField }
  | { type: 'custom'; customFieldId: string; fieldName: string; fieldType: string }
  | { type: 'ignore' };

/** Map of spreadsheet column name -> target field mapping */
export type ColumnMapping = Record<string, FieldMappingTarget>;

export type RawImportRow = Record<string, string>;

export interface ParsedCsvData {
  headers: string[];
  rows: RawImportRow[];
}

export interface FieldValidationError {
  rowNumber: number;
  phone: string;
  column: string;
  value: string;
  error: string;
}

export interface PreflightPreviewRow {
  rowNumber: number;
  phone: string;
  name?: string;
  status: 'will_update' | 'will_create' | 'unmatched' | 'invalid_phone' | 'duplicate';
  existingContactId?: string;
  standardChanges: Record<string, string>;
  customChanges: Record<string, string>;
}

export interface PreflightAnalysisResult {
  totalRows: number;
  matchedCount: number;
  unmatchedCount: number;
  newContactsCount: number;
  duplicateCount: number;
  invalidPhoneCount: number;
  validationErrorCount: number;
  fieldErrors: FieldValidationError[];
  previewRows: PreflightPreviewRow[];
}

export interface ImportExecutionResult {
  imported: number;
  updated: number;
  unmatched: number;
  skipped: number;
  invalidPhone: number;
  failed: number;
  tagsAssigned: number;
  customFieldsUpdated: number;
  unmatchedDetails: Array<{ rowNumber: number; phone: string; name?: string; reason: string }>;
  failedDetails: Array<{ rowNumber: number; phone: string; name?: string; reason: string }>;
}

/**
 * Robust RFC 4180 CSV parser handling commas, double quotes (""), and multiline values.
 */
export function parseGenericCsv(text: string): ParsedCsvData {
  const trimmed = text.trim();
  if (!trimmed) {
    return { headers: [], rows: [] };
  }

  const rawRows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote "" -> "
          currentCell += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        currentCell += char;
        i++;
        continue;
      }
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentCell.trim());
      currentCell = '';
      i++;
      continue;
    }

    if (char === '\r' || char === '\n') {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      currentCell = '';
      if (currentRow.some((cell) => cell.length > 0)) {
        rawRows.push(currentRow);
      }
      currentRow = [];
      i++;
      continue;
    }

    currentCell += char;
    i++;
  }

  // Push final cell/row if present
  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell.length > 0)) {
      rawRows.push(currentRow);
    }
  }

  if (rawRows.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = rawRows[0].map((h) => h.replace(/^["']|["']$/g, '').trim());
  const rows: RawImportRow[] = [];

  for (let r = 1; r < rawRows.length; r++) {
    const cells = rawRows[r];
    const rowObj: RawImportRow = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      rowObj[header] = cells[c] ?? '';
    }
    rows.push(rowObj);
  }

  return { headers, rows };
}

/**
 * Intelligent auto-mapping heuristics for spreadsheet column headers.
 */
export function autoDetectColumnMapping(
  headers: string[],
  customFields: CustomField[]
): ColumnMapping {
  const mapping: ColumnMapping = {};
  const customFieldByName = new Map<string, CustomField>();

  for (const cf of customFields) {
    const key = cf.field_name.toLowerCase().replace(/[-_\s]+/g, '');
    customFieldByName.set(key, cf);
  }

  for (const header of headers) {
    const clean = header.toLowerCase().replace(/[-_\s]+/g, '');

    if (
      clean === 'phone' ||
      clean === 'phonenumber' ||
      clean === 'mobile' ||
      clean === 'mobilenumber' ||
      clean === 'whatsapp' ||
      clean === 'whatsappnumber' ||
      clean === 'telephone' ||
      clean === 'contactnumber'
    ) {
      mapping[header] = { type: 'standard', field: 'phone' };
    } else if (
      clean === 'name' ||
      clean === 'fullname' ||
      clean === 'contactname' ||
      clean === 'customername'
    ) {
      mapping[header] = { type: 'standard', field: 'name' };
    } else if (
      clean === 'email' ||
      clean === 'emailaddress' ||
      clean === 'mail'
    ) {
      mapping[header] = { type: 'standard', field: 'email' };
    } else if (
      clean === 'company' ||
      clean === 'organization' ||
      clean === 'companyname' ||
      clean === 'business'
    ) {
      mapping[header] = { type: 'standard', field: 'company' };
    } else if (clean === 'tags' || clean === 'tag') {
      mapping[header] = { type: 'standard', field: 'tags' };
    } else if (customFieldByName.has(clean)) {
      const cf = customFieldByName.get(clean)!;
      mapping[header] = {
        type: 'custom',
        customFieldId: cf.id,
        fieldName: cf.field_name,
        fieldType: cf.field_type,
      };
    } else {
      mapping[header] = { type: 'ignore' };
    }
  }

  return mapping;
}

/**
 * Validates a custom field value against its configured data type.
 */
export function validateCustomFieldValue(
  value: string,
  fieldType: string,
  fieldOptions?: Record<string, unknown>
): { valid: boolean; error?: string; normalizedValue: string } {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { valid: true, normalizedValue: '' };
  }

  switch (fieldType.toLowerCase()) {
    case 'number': {
      const num = Number(trimmed);
      if (Number.isNaN(num)) {
        return {
          valid: false,
          error: `Value "${value}" is not a valid number`,
          normalizedValue: trimmed,
        };
      }
      return { valid: true, normalizedValue: String(num) };
    }

    case 'boolean': {
      const lower = trimmed.toLowerCase();
      if (['true', 'yes', '1', 'y', 'si'].includes(lower)) {
        return { valid: true, normalizedValue: 'true' };
      }
      if (['false', 'no', '0', 'n'].includes(lower)) {
        return { valid: true, normalizedValue: 'false' };
      }
      return {
        valid: false,
        error: `Value "${value}" is not a valid boolean (expected true/false, yes/no, 1/0)`,
        normalizedValue: trimmed,
      };
    }

    case 'date': {
      const timestamp = Date.parse(trimmed);
      if (Number.isNaN(timestamp)) {
        return {
          valid: false,
          error: `Value "${value}" is not a valid date format`,
          normalizedValue: trimmed,
        };
      }
      const iso = new Date(timestamp).toISOString().slice(0, 10);
      return { valid: true, normalizedValue: iso };
    }

    case 'select': {
      const choices = (fieldOptions?.options || fieldOptions?.choices) as
        | string[]
        | undefined;
      if (Array.isArray(choices) && choices.length > 0) {
        const match = choices.find(
          (c) => c.trim().toLowerCase() === trimmed.toLowerCase()
        );
        if (!match) {
          return {
            valid: false,
            error: `Value "${value}" is not one of the allowed options: ${choices.join(', ')}`,
            normalizedValue: trimmed,
          };
        }
        return { valid: true, normalizedValue: match };
      }
      return { valid: true, normalizedValue: trimmed };
    }

    case 'text':
    default:
      return { valid: true, normalizedValue: trimmed };
  }
}

/**
 * Pre-flight analysis comparing spreadsheet data against existing contacts.
 */
export function preflightImportAnalysis(params: {
  rows: RawImportRow[];
  mapping: ColumnMapping;
  mode: ImportMode;
  existingContacts: ExistingContact[];
  customFields: CustomField[];
}): PreflightAnalysisResult {
  const { rows, mapping, mode, existingContacts, customFields } = params;

  // Find the column mapped to 'phone'
  let phoneHeader: string | null = null;
  for (const [header, target] of Object.entries(mapping)) {
    if (target.type === 'standard' && target.field === 'phone') {
      phoneHeader = header;
      break;
    }
  }

  // Pre-build index of existing contacts
  const existingByNorm = new Map<string, ExistingContact>();
  for (const contact of existingContacts) {
    const key = normalizeKey(contact.phone);
    if (key) {
      existingByNorm.set(key, contact);
    }
  }

  const cfMap = new Map<string, CustomField>();
  for (const cf of customFields) {
    cfMap.set(cf.id, cf);
  }

  const seenInFile = new Set<string>();
  const previewRows: PreflightPreviewRow[] = [];
  const fieldErrors: FieldValidationError[] = [];

  let matchedCount = 0;
  let unmatchedCount = 0;
  let newContactsCount = 0;
  let duplicateCount = 0;
  let invalidPhoneCount = 0;

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const rowNumber = idx + 2; // +1 for 1-based, +1 for header line
    const rawPhone = phoneHeader ? (row[phoneHeader] ?? '').trim() : '';

    if (!rawPhone) {
      invalidPhoneCount++;
      previewRows.push({
        rowNumber,
        phone: rawPhone,
        status: 'invalid_phone',
        standardChanges: {},
        customChanges: {},
      });
      continue;
    }

    const normPhone = normalizePhone(rawPhone);
    if (!normPhone || normPhone.length < 7) {
      invalidPhoneCount++;
      previewRows.push({
        rowNumber,
        phone: rawPhone,
        status: 'invalid_phone',
        standardChanges: {},
        customChanges: {},
      });
      continue;
    }

    if (seenInFile.has(normPhone)) {
      duplicateCount++;
      previewRows.push({
        rowNumber,
        phone: rawPhone,
        status: 'duplicate',
        standardChanges: {},
        customChanges: {},
      });
      continue;
    }
    seenInFile.add(normPhone);

    // Validate custom fields in this row
    const standardChanges: Record<string, string> = {};
    const customChanges: Record<string, string> = {};

    for (const [colName, target] of Object.entries(mapping)) {
      const cellVal = (row[colName] ?? '').trim();
      if (!cellVal) continue; // blank values are ignored for changes

      if (target.type === 'standard') {
        if (target.field !== 'phone') {
          standardChanges[target.field] = cellVal;
        }
      } else if (target.type === 'custom') {
        const cf = cfMap.get(target.customFieldId);
        const fieldType = cf ? cf.field_type : target.fieldType;
        const validation = validateCustomFieldValue(cellVal, fieldType, cf?.field_options);
        if (!validation.valid) {
          fieldErrors.push({
            rowNumber,
            phone: rawPhone,
            column: colName,
            value: cellVal,
            error: validation.error ?? 'Invalid format',
          });
        } else {
          customChanges[target.fieldName] = validation.normalizedValue;
        }
      }
    }

    // Match against existing contact
    let matchedContact = existingByNorm.get(normPhone);
    if (!matchedContact) {
      // Suffix fallback via phonesMatch
      matchedContact =
        existingContacts.find((c) => phonesMatch(c.phone, rawPhone)) ?? undefined;
    }

    let status: PreflightPreviewRow['status'];
    if (matchedContact) {
      matchedCount++;
      if (mode === 'create') {
        status = 'duplicate'; // In create mode, existing contact is skipped
      } else {
        status = 'will_update';
      }
    } else {
      unmatchedCount++;
      if (mode === 'create' || mode === 'create_update') {
        newContactsCount++;
        status = 'will_create';
      } else {
        status = 'unmatched';
      }
    }

    previewRows.push({
      rowNumber,
      phone: rawPhone,
      name: standardChanges.name,
      status,
      existingContactId: matchedContact?.id,
      standardChanges,
      customChanges,
    });
  }

  return {
    totalRows: rows.length,
    matchedCount,
    unmatchedCount,
    newContactsCount,
    duplicateCount,
    invalidPhoneCount,
    validationErrorCount: fieldErrors.length,
    fieldErrors,
    previewRows,
  };
}

/**
 * Core contact import executor supporting Create, Update, and Create+Update modes.
 */
export async function executeContactImport(params: {
  supabase: SupabaseClient;
  accountId: string;
  userId: string;
  rows: RawImportRow[];
  mapping: ColumnMapping;
  mode: ImportMode;
  customFields: CustomField[];
  canCreateTags?: boolean;
}): Promise<ImportExecutionResult> {
  const {
    supabase,
    accountId,
    userId,
    rows,
    mapping,
    mode,
    customFields,
    canCreateTags = false,
  } = params;

  // 1) Find phone column
  let phoneHeader: string | null = null;
  for (const [header, target] of Object.entries(mapping)) {
    if (target.type === 'standard' && target.field === 'phone') {
      phoneHeader = header;
      break;
    }
  }

  if (!phoneHeader) {
    throw new Error('A column must be mapped to the Phone field as matching identifier.');
  }

  const cfMap = new Map<string, CustomField>();
  for (const cf of customFields) {
    cfMap.set(cf.id, cf);
  }

  let imported = 0;
  let updated = 0;
  let unmatched = 0;
  let skipped = 0;
  let invalidPhone = 0;
  let failed = 0;
  let tagsAssigned = 0;
  let customFieldsUpdated = 0;

  const unmatchedDetails: ImportExecutionResult['unmatchedDetails'] = [];
  const failedDetails: ImportExecutionResult['failedDetails'] = [];

  // 2) Parse & validate rows
  interface PreparedRow {
    rowNumber: number;
    rawPhone: string;
    normPhone: string;
    name?: string;
    email?: string;
    company?: string;
    tagNames: string[];
    customValues: Array<{ customFieldId: string; value: string }>;
  }

  const preparedRows: PreparedRow[] = [];
  const seenPhones = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2;
    const rawPhone = (row[phoneHeader] ?? '').trim();

    if (!rawPhone) {
      invalidPhone++;
      continue;
    }

    const normPhone = normalizePhone(rawPhone);
    if (!normPhone || normPhone.length < 7) {
      invalidPhone++;
      continue;
    }

    if (seenPhones.has(normPhone)) {
      skipped++;
      continue;
    }
    seenPhones.add(normPhone);

    let rowName: string | undefined;
    let rowEmail: string | undefined;
    let rowCompany: string | undefined;
    let rowTags: string[] = [];
    const customValues: Array<{ customFieldId: string; value: string }> = [];
    let hasRowError = false;

    for (const [colName, target] of Object.entries(mapping)) {
      const rawVal = (row[colName] ?? '').trim();
      if (!rawVal) continue; // Skip blank cells

      if (target.type === 'standard') {
        if (target.field === 'name') rowName = rawVal;
        else if (target.field === 'email') rowEmail = rawVal;
        else if (target.field === 'company') rowCompany = rawVal;
        else if (target.field === 'tags') rowTags = parseTagCell(rawVal);
      } else if (target.type === 'custom') {
        const cf = cfMap.get(target.customFieldId);
        const fieldType = cf ? cf.field_type : target.fieldType;
        const validation = validateCustomFieldValue(rawVal, fieldType, cf?.field_options);
        if (!validation.valid) {
          failed++;
          failedDetails.push({
            rowNumber,
            phone: rawPhone,
            name: rowName,
            reason: `${target.fieldName}: ${validation.error}`,
          });
          hasRowError = true;
          break;
        } else if (validation.normalizedValue !== '') {
          customValues.push({
            customFieldId: target.customFieldId,
            value: validation.normalizedValue,
          });
        }
      }
    }

    if (hasRowError) continue;

    preparedRows.push({
      rowNumber,
      rawPhone,
      normPhone,
      name: rowName,
      email: rowEmail,
      company: rowCompany,
      tagNames: rowTags,
      customValues,
    });
  }

  if (preparedRows.length === 0) {
    return {
      imported,
      updated,
      unmatched,
      skipped,
      invalidPhone,
      failed,
      tagsAssigned,
      customFieldsUpdated,
      unmatchedDetails,
      failedDetails,
    };
  }

  // 3) Batch fetch existing contacts for matching
  const allNormPhones = preparedRows.map((r) => r.normPhone);
  const existingContactsMap = new Map<string, ExistingContact>();

  const batchSize = 200;
  for (let i = 0; i < allNormPhones.length; i += batchSize) {
    const chunk = allNormPhones.slice(i, i + batchSize);
    const { data: contacts, error: fetchErr } = await supabase
      .from('contacts')
      .select('id, phone, phone_normalized, name, email, company')
      .eq('account_id', accountId)
      .in('phone_normalized', chunk);

    if (fetchErr) {
      throw fetchErr;
    }

    for (const c of (contacts ?? []) as ExistingContact[]) {
      const key = normalizeKey(c.phone);
      if (key) {
        existingContactsMap.set(key, c);
      }
    }
  }

  // Suffix fallback check for any remaining unmatched numbers
  const unmatchedKeys = allNormPhones.filter((k) => !existingContactsMap.has(k));
  if (unmatchedKeys.length > 0 && unmatchedKeys.length <= 50) {
    for (const k of unmatchedKeys) {
      const suffix = k.length >= 8 ? k.slice(-8) : k;
      const { data } = await supabase
        .from('contacts')
        .select('id, phone, phone_normalized, name, email, company')
        .eq('account_id', accountId)
        .like('phone', `%${suffix}`);

      const matched = (data as ExistingContact[] | null)?.find((c) => phonesMatch(c.phone, k));
      if (matched) {
        existingContactsMap.set(k, matched);
      }
    }
  }

  // 4) Segregate rows into Updates and Inserts
  interface UpdateOp {
    contactId: string;
    rowNumber: number;
    phone: string;
    name?: string;
    email?: string;
    company?: string;
    customValues: Array<{ customFieldId: string; value: string }>;
    tagNames: string[];
  }

  interface InsertOp {
    rowNumber: number;
    phone: string;
    name?: string;
    email?: string;
    company?: string;
    customValues: Array<{ customFieldId: string; value: string }>;
    tagNames: string[];
  }

  const updatesToApply: UpdateOp[] = [];
  const insertsToApply: InsertOp[] = [];

  for (const row of preparedRows) {
    const existing = existingContactsMap.get(row.normPhone);

    if (existing) {
      if (mode === 'create') {
        skipped++;
      } else {
        // update or create_update
        updatesToApply.push({
          contactId: existing.id,
          rowNumber: row.rowNumber,
          phone: row.rawPhone,
          name: row.name,
          email: row.email,
          company: row.company,
          customValues: row.customValues,
          tagNames: row.tagNames,
        });
      }
    } else {
      if (mode === 'update') {
        unmatched++;
        unmatchedDetails.push({
          rowNumber: row.rowNumber,
          phone: row.rawPhone,
          name: row.name,
          reason: 'No existing contact found with this phone number',
        });
      } else {
        // create or create_update
        insertsToApply.push({
          rowNumber: row.rowNumber,
          phone: row.rawPhone,
          name: row.name,
          email: row.email,
          company: row.company,
          customValues: row.customValues,
          tagNames: row.tagNames,
        });
      }
    }
  }

  const tagAssignments: ContactTagAssignment[] = [];
  const customValueUpserts: Array<{ contact_id: string; custom_field_id: string; value: string }> = [];

  // 5) Process Updates
  for (const up of updatesToApply) {
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (up.name !== undefined) updatePayload.name = up.name;
    if (up.email !== undefined) updatePayload.email = up.email;
    if (up.company !== undefined) updatePayload.company = up.company;

    if (Object.keys(updatePayload).length > 1) {
      const { error: updErr } = await supabase
        .from('contacts')
        .update(updatePayload)
        .eq('id', up.contactId)
        .eq('account_id', accountId);

      if (updErr) {
        failed++;
        failedDetails.push({
          rowNumber: up.rowNumber,
          phone: up.phone,
          name: up.name,
          reason: updErr.message,
        });
        continue;
      }
    }

    updated++;

    for (const cv of up.customValues) {
      customValueUpserts.push({
        contact_id: up.contactId,
        custom_field_id: cv.customFieldId,
        value: cv.value,
      });
    }

    if (up.tagNames.length > 0) {
      tagAssignments.push({
        contactId: up.contactId,
        tagNames: up.tagNames,
      });
    }
  }

  // 6) Process Inserts
  const insertChunkSize = 50;
  for (let i = 0; i < insertsToApply.length; i += insertChunkSize) {
    const chunk = insertsToApply.slice(i, i + insertChunkSize);
    const dbRows = chunk.map((c) => {
      // Normalize to E.164 leading + if international, otherwise keep digits
      let formattedPhone = c.phone.trim();
      const parsed = parseInternationalPhone(formattedPhone);
      if (parsed) {
        formattedPhone = `+${parsed}`;
      } else if (!formattedPhone.startsWith('+') && isValidE164(formattedPhone)) {
        formattedPhone = `+${formattedPhone}`;
      }
      return {
        account_id: accountId,
        user_id: userId,
        phone: formattedPhone,
        name: c.name || null,
        email: c.email || null,
        company: c.company || null,
      };
    });

    const { data: inserted, error: insErr } = await supabase
      .from('contacts')
      .insert(dbRows)
      .select('id, phone');

    if (insErr) {
      // Fallback single-row insert
      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j];
        const rowData = dbRows[j];
        const { data: singleData, error: singleErr } = await supabase
          .from('contacts')
          .insert(rowData)
          .select('id')
          .single();

        if (!singleErr && singleData) {
          imported++;
          for (const cv of item.customValues) {
            customValueUpserts.push({
              contact_id: singleData.id,
              custom_field_id: cv.customFieldId,
              value: cv.value,
            });
          }
          if (item.tagNames.length > 0) {
            tagAssignments.push({
              contactId: singleData.id,
              tagNames: item.tagNames,
            });
          }
        } else if (isUniqueViolation(singleErr)) {
          skipped++;
        } else {
          failed++;
          failedDetails.push({
            rowNumber: item.rowNumber,
            phone: item.phone,
            name: item.name,
            reason: singleErr?.message || 'Insert failed',
          });
        }
      }
    } else {
      const records = inserted ?? [];
      imported += records.length;
      for (let j = 0; j < records.length; j++) {
        const rec = records[j];
        const item = chunk[j];
        if (!rec || !item) continue;
        for (const cv of item.customValues) {
          customValueUpserts.push({
            contact_id: rec.id,
            custom_field_id: cv.customFieldId,
            value: cv.value,
          });
        }
        if (item.tagNames.length > 0) {
          tagAssignments.push({
            contactId: rec.id,
            tagNames: item.tagNames,
          });
        }
      }
    }
  }

  // 7) Batch Upsert Custom Values (Merging!)
  if (customValueUpserts.length > 0) {
    // Deduplicate (contact_id, custom_field_id) in memory so Postgres never throws 21000
    const dedupedCustoms = new Map<string, { contact_id: string; custom_field_id: string; value: string }>();
    for (const cv of customValueUpserts) {
      const key = `${cv.contact_id}:${cv.custom_field_id}`;
      dedupedCustoms.set(key, cv);
    }

    const customRows = Array.from(dedupedCustoms.values());
    const cvChunkSize = 100;
    for (let i = 0; i < customRows.length; i += cvChunkSize) {
      const chunk = customRows.slice(i, i + cvChunkSize);
      const { error: cvErr } = await supabase
        .from('contact_custom_values')
        .upsert(chunk, {
          onConflict: 'contact_id,custom_field_id',
        });

      if (!cvErr) {
        customFieldsUpdated += chunk.length;
      } else {
        console.error('[contact import] failed to upsert custom values:', cvErr);
      }
    }
  }

  // 8) Wire Tags
  if (tagAssignments.length > 0) {
    try {
      const allTagNames = tagAssignments.flatMap((ta) => ta.tagNames);
      const { tagIdByKey } = await resolveImportTagIds(supabase, {
        accountId,
        userId,
        tagNames: allTagNames,
        canCreateTags,
      });

      tagsAssigned = await assignImportedContactTags(supabase, tagAssignments, tagIdByKey);
    } catch (tagErr) {
      console.warn('[contact import] tag assignment warning:', tagErr);
    }
  }

  return {
    imported,
    updated,
    unmatched,
    skipped,
    invalidPhone,
    failed,
    tagsAssigned,
    customFieldsUpdated,
    unmatchedDetails,
    failedDetails,
  };
}
