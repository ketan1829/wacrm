'use client';

import { useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { CustomField } from '@/types';
import {
  parseGenericCsv,
  autoDetectColumnMapping,
  preflightImportAnalysis,
  executeContactImport,
  type ImportMode,
  type ColumnMapping,
  type PreflightAnalysisResult,
  type ImportExecutionResult,
  type RawImportRow,
  type StandardContactField,
} from '@/lib/contacts/import-engine';
import type { ExistingContact } from '@/lib/contacts/dedupe';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  UserCheck,
  UserPlus,
  RefreshCw,
  Plus,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

const PREVIEW_LIMIT = 5;

type Step = 'file_mode' | 'mapping' | 'preview';

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const t = useTranslations('Contacts.importModal');
  const supabase = createClient();
  const { accountId, user, canEditSettings } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('file_mode');
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ImportMode>('create');
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<RawImportRow[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [customFields, setCustomFields] = useState<CustomField[]>([]);

  // Inline custom field creation
  const [newFieldName, setNewFieldName] = useState('');
  const [isAddingCustomField, setIsAddingCustomField] = useState(false);
  const [creatingCustomField, setCreatingCustomField] = useState(false);

  // Preflight & Execution states
  const [analyzing, setAnalyzing] = useState(false);
  const [preflight, setPreflight] = useState<PreflightAnalysisResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportExecutionResult | null>(null);

  function reset() {
    setStep('file_mode');
    setFile(null);
    setMode('create');
    setCsvHeaders([]);
    setCsvRows([]);
    setMapping({});
    setPreflight(null);
    setResult(null);
    setIsAddingCustomField(false);
    setNewFieldName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function fetchAccountCustomFields() {
    if (!accountId) return [];
    const { data } = await supabase
      .from('custom_fields')
      .select('*')
      .eq('account_id', accountId)
      .order('field_name');
    const fields = (data as CustomField[] | null) ?? [];
    setCustomFields(fields);
    return fields;
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);
    setPreflight(null);

    const text = await selected.text();
    const { headers, rows } = parseGenericCsv(text);

    if (rows.length === 0 || headers.length === 0) {
      toast.error(t('toastNoValidRows'));
      setFile(null);
      setCsvHeaders([]);
      setCsvRows([]);
      return;
    }

    setCsvHeaders(headers);
    setCsvRows(rows);

    const fields = await fetchAccountCustomFields();
    const detectedMapping = autoDetectColumnMapping(headers, fields);
    setMapping(detectedMapping);
  }

  async function handleCreateNewCustomField() {
    const name = newFieldName.trim();
    if (!name || !accountId || !user) return;

    setCreatingCustomField(true);
    const { data, error } = await supabase
      .from('custom_fields')
      .insert({
        field_name: name,
        field_type: 'text',
        user_id: user.id,
        account_id: accountId,
      })
      .select('*')
      .single();

    setCreatingCustomField(false);

    if (error || !data) {
      toast.error(error?.message || 'Failed to create custom field');
      return;
    }

    const createdField = data as CustomField;
    const updatedList = [...customFields, createdField];
    setCustomFields(updatedList);
    setNewFieldName('');
    setIsAddingCustomField(false);
    toast.success(`Created custom field "${createdField.field_name}"`);
  }

  function handleMappingChange(header: string, rawValue: string) {
    setMapping((prev) => {
      const next = { ...prev };
      if (rawValue === 'ignore') {
        next[header] = { type: 'ignore' };
      } else if (rawValue.startsWith('standard:')) {
        const field = rawValue.replace('standard:', '') as StandardContactField;
        next[header] = { type: 'standard', field };
      } else if (rawValue.startsWith('custom:')) {
        const customFieldId = rawValue.replace('custom:', '');
        const cf = customFields.find((f) => f.id === customFieldId);
        if (cf) {
          next[header] = {
            type: 'custom',
            customFieldId: cf.id,
            fieldName: cf.field_name,
            fieldType: cf.field_type,
          };
        }
      }
      return next;
    });
  }

  async function handleGoToPreview() {
    // Check if phone is mapped
    const hasPhone = Object.values(mapping).some(
      (target) => target.type === 'standard' && target.field === 'phone'
    );
    if (!hasPhone) {
      toast.error(t('phoneMappingRequired'));
      return;
    }

    if (!accountId) return;

    setAnalyzing(true);
    try {
      // Batch fetch existing contacts for preflight matching
      const { data: contactsData } = await supabase
        .from('contacts')
        .select('id, phone, phone_normalized, name, email, company')
        .eq('account_id', accountId);

      const existingContacts = (contactsData ?? []) as ExistingContact[];

      const analysis = preflightImportAnalysis({
        rows: csvRows,
        mapping,
        mode,
        existingContacts,
        customFields,
      });

      setPreflight(analysis);
      setStep('preview');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to analyze rows';
      toast.error(msg);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleExecuteImport() {
    if (csvRows.length === 0 || !accountId || !user) return;
    setImporting(true);

    try {
      const res = await executeContactImport({
        supabase,
        accountId,
        userId: user.id,
        rows: csvRows,
        mapping,
        mode,
        customFields,
        canCreateTags: canEditSettings,
      });

      setResult(res);

      if (res.imported > 0) {
        toast.success(t('toastImported', { count: res.imported }));
        onImported();
      }
      if (res.updated > 0) {
        toast.success(t('resultUpdated', { count: res.updated }));
        onImported();
      }
      if (res.unmatched > 0) {
        toast.info(t('resultUnmatched', { count: res.unmatched }));
      }
      if (res.skipped > 0) {
        toast.info(t('toastSkipped', { count: res.skipped }));
      }
      if (res.failed > 0) {
        toast.error(t('toastFailed', { count: res.failed }));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  // Sample data getter for mapping view
  const sampleValuesByHeader = useMemo(() => {
    const samples: Record<string, string> = {};
    for (const h of csvHeaders) {
      const vals: string[] = [];
      for (const row of csvRows) {
        const v = (row[h] ?? '').trim();
        if (v && !vals.includes(v)) {
          vals.push(v);
          if (vals.length >= 2) break;
        }
      }
      samples[h] = vals.join(', ') || '—';
    }
    return samples;
  }, [csvHeaders, csvRows]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,760px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        {/* Header */}
        <div className="shrink-0 space-y-3 border-b border-border/80 px-6 pt-6 pb-4">
          <DialogHeader className="gap-1">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-lg text-popover-foreground">
                {t('title')}
              </DialogTitle>
              {!result && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 font-medium',
                      step === 'file_mode'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    1. File & Mode
                  </span>
                  <ChevronRight className="size-3 text-muted-foreground" />
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 font-medium',
                      step === 'mapping'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    2. Map
                  </span>
                  <ChevronRight className="size-3 text-muted-foreground" />
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 font-medium',
                      step === 'preview'
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    3. Preview
                  </span>
                </div>
              )}
            </div>
            <DialogDescription className="text-xs leading-relaxed text-muted-foreground">
              {step === 'file_mode' && t('desc', { phoneCode: 'phone', nameCode: 'name', emailCode: 'email', companyCode: 'company', tagsCode: 'tags' })}
              {step === 'mapping' && t('mappingDesc')}
              {step === 'preview' && 'Review pre-flight analysis before applying changes.'}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Content Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {/* STEP 1: FILE & MODE */}
          {step === 'file_mode' && !result && (
            <div className="space-y-5">
              {/* Dropzone */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
                }}
                className={cn(
                  'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
                  file
                    ? 'border-primary/35 bg-primary/[0.04]'
                    : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70'
                )}
              >
                {file ? (
                  <>
                    <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                      <FileText className="text-primary size-5" />
                    </div>
                    <p className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground">
                      {truncateFilename(file.name)}
                    </p>
                    <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {t('rowsReady', { count: csvRows.length })}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                      <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">{t('uploadDropzone')}</p>
                    <p className="text-[11px] text-muted-foreground">{t('uploadHint')}</p>
                  </>
                )}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="hidden"
              />

              {/* Mode Selection */}
              <div className="space-y-2.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('modeTitle')}
                </label>
                <div className="grid gap-2.5 sm:grid-cols-3">
                  {/* Create New */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMode('create')}
                    className={cn(
                      'flex cursor-pointer flex-col justify-between rounded-xl border p-3 transition-all',
                      mode === 'create'
                        ? 'border-primary bg-primary/[0.06] ring-1 ring-primary'
                        : 'border-border bg-background/50 hover:bg-muted/40'
                    )}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 font-medium text-xs text-popover-foreground">
                        <UserPlus className="size-3.5 text-primary" />
                        <span>{t('modeCreate')}</span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {t('modeCreateDesc')}
                      </p>
                    </div>
                  </div>

                  {/* Update Existing */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMode('update')}
                    className={cn(
                      'flex cursor-pointer flex-col justify-between rounded-xl border p-3 transition-all',
                      mode === 'update'
                        ? 'border-emerald-500 bg-emerald-500/[0.06] ring-1 ring-emerald-500'
                        : 'border-border bg-background/50 hover:bg-muted/40'
                    )}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 font-medium text-xs text-popover-foreground">
                        <RefreshCw className="size-3.5 text-emerald-400" />
                        <span>{t('modeUpdate')}</span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {t('modeUpdateDesc')}
                      </p>
                    </div>
                  </div>

                  {/* Create + Update */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setMode('create_update')}
                    className={cn(
                      'flex cursor-pointer flex-col justify-between rounded-xl border p-3 transition-all',
                      mode === 'create_update'
                        ? 'border-cyan-500 bg-cyan-500/[0.06] ring-1 ring-cyan-500'
                        : 'border-border bg-background/50 hover:bg-muted/40'
                    )}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 font-medium text-xs text-popover-foreground">
                        <UserCheck className="size-3.5 text-cyan-400" />
                        <span>{t('modeCreateUpdate')}</span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {t('modeCreateUpdateDesc')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: COLUMN MAPPING */}
          {step === 'mapping' && !result && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Map each spreadsheet column to a WACRM contact field.
                </span>
                {canEditSettings && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsAddingCustomField((prev) => !prev)}
                    className="h-7 gap-1 text-[11px]"
                  >
                    <Plus className="size-3" />
                    Custom field
                  </Button>
                )}
              </div>

              {/* Inline Custom Field Creator */}
              {isAddingCustomField && (
                <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.03] p-2.5">
                  <Input
                    value={newFieldName}
                    onChange={(e) => setNewFieldName(e.target.value)}
                    placeholder="New custom field name (e.g. Clinic Name, Rating)"
                    className="h-8 text-xs bg-background"
                  />
                  <Button
                    size="sm"
                    onClick={handleCreateNewCustomField}
                    disabled={creatingCustomField || !newFieldName.trim()}
                    className="h-8 text-xs shrink-0"
                  >
                    {creatingCustomField && <Loader2 className="size-3 animate-spin mr-1" />}
                    Add
                  </Button>
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                      <th className="px-3.5 py-2.5 text-left font-medium">{t('colSpreadsheet')}</th>
                      <th className="px-3.5 py-2.5 text-left font-medium">{t('colSample')}</th>
                      <th className="px-3.5 py-2.5 text-left font-medium">{t('colTarget')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {csvHeaders.map((header) => {
                      const currentTarget = mapping[header] ?? { type: 'ignore' };
                      let selectVal = 'ignore';
                      if (currentTarget.type === 'standard') {
                        selectVal = `standard:${currentTarget.field}`;
                      } else if (currentTarget.type === 'custom') {
                        selectVal = `custom:${currentTarget.customFieldId}`;
                      }

                      return (
                        <tr key={header} className="hover:bg-muted/20">
                          <td className="px-3.5 py-2.5 font-medium text-popover-foreground">
                            {header}
                          </td>
                          <td className="px-3.5 py-2.5 text-muted-foreground max-w-[12rem] truncate" title={sampleValuesByHeader[header]}>
                            {sampleValuesByHeader[header]}
                          </td>
                          <td className="px-3.5 py-2.5">
                            <select
                              value={selectVal}
                              onChange={(e) => handleMappingChange(header, e.target.value)}
                              className="w-full h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              <option value="ignore">{t('doNotImport')}</option>
                              <optgroup label={t('groupStandard')}>
                                <option value="standard:phone">Phone (Identifier) *</option>
                                <option value="standard:name">Name</option>
                                <option value="standard:email">Email</option>
                                <option value="standard:company">Company</option>
                                <option value="standard:tags">Tags (Comma-separated)</option>
                              </optgroup>
                              {customFields.length > 0 && (
                                <optgroup label={t('groupCustom')}>
                                  {customFields.map((cf) => (
                                    <option key={cf.id} value={`custom:${cf.id}`}>
                                      {cf.field_name} ({cf.field_type})
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* STEP 3: PREVIEW & RUN */}
          {step === 'preview' && preflight && !result && (
            <div className="space-y-4">
              {/* Preflight Metric Cards */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="rounded-xl border border-border bg-background/50 p-3">
                  <p className="text-[11px] font-medium text-muted-foreground uppercase">{t('metricTotal')}</p>
                  <p className="mt-1 text-xl font-bold text-popover-foreground">{preflight.totalRows}</p>
                </div>
                {mode !== 'create' && (
                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
                    <p className="text-[11px] font-medium text-emerald-400 uppercase">{t('metricMatched')}</p>
                    <p className="mt-1 text-xl font-bold text-emerald-400">{preflight.matchedCount}</p>
                  </div>
                )}
                {mode !== 'update' && (
                  <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-3">
                    <p className="text-[11px] font-medium text-primary uppercase">{t('metricNew')}</p>
                    <p className="mt-1 text-xl font-bold text-primary">{preflight.newContactsCount}</p>
                  </div>
                )}
                {mode === 'update' && (
                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3">
                    <p className="text-[11px] font-medium text-amber-400 uppercase">{t('metricUnmatched')}</p>
                    <p className="mt-1 text-xl font-bold text-amber-400">{preflight.unmatchedCount}</p>
                  </div>
                )}
                {preflight.duplicateCount > 0 && (
                  <div className="rounded-xl border border-border bg-background/50 p-3">
                    <p className="text-[11px] font-medium text-muted-foreground uppercase">{t('metricDuplicates')}</p>
                    <p className="mt-1 text-xl font-bold text-muted-foreground">{preflight.duplicateCount}</p>
                  </div>
                )}
                {preflight.invalidPhoneCount > 0 && (
                  <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-3">
                    <p className="text-[11px] font-medium text-red-400 uppercase">{t('metricInvalid')}</p>
                    <p className="mt-1 text-xl font-bold text-red-400">{preflight.invalidPhoneCount}</p>
                  </div>
                )}
              </div>

              {/* Field Validation Warning */}
              {preflight.fieldErrors.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-3.5 text-xs text-amber-200">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="size-4 shrink-0 text-amber-400" />
                    <span>{preflight.fieldErrors.length} custom field validation error(s) detected</span>
                  </div>
                  <ul className="mt-2 list-disc list-inside space-y-1 text-muted-foreground">
                    {preflight.fieldErrors.slice(0, 3).map((err, i) => (
                      <li key={i}>
                        Row {err.rowNumber} ({err.phone}): {err.column} — {err.error}
                      </li>
                    ))}
                    {preflight.fieldErrors.length > 3 && (
                      <li>+{preflight.fieldErrors.length - 3} more errors</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Preview Rows Table */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Sample rows (First {Math.min(PREVIEW_LIMIT, preflight.previewRows.length)})
                </p>
                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                        <th className="px-3 py-2 text-left font-medium">Phone</th>
                        <th className="px-3 py-2 text-left font-medium">Action</th>
                        <th className="px-3 py-2 text-left font-medium">Standard Updates</th>
                        <th className="px-3 py-2 text-left font-medium">Custom Field Merges</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {preflight.previewRows.slice(0, PREVIEW_LIMIT).map((pRow, idx) => (
                        <tr key={idx} className="hover:bg-muted/20">
                          <td className="px-3 py-2 font-mono text-[11px] text-popover-foreground whitespace-nowrap">
                            {pRow.phone || '—'}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {pRow.status === 'will_update' && (
                              <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                                Will Update
                              </Badge>
                            )}
                            {pRow.status === 'will_create' && (
                              <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10">
                                Will Create
                              </Badge>
                            )}
                            {pRow.status === 'unmatched' && (
                              <Badge variant="outline" className="border-amber-500/30 text-amber-400 bg-amber-500/10">
                                Unmatched
                              </Badge>
                            )}
                            {pRow.status === 'duplicate' && (
                              <Badge variant="outline" className="border-border text-muted-foreground bg-muted">
                                Duplicate (Skip)
                              </Badge>
                            )}
                            {pRow.status === 'invalid_phone' && (
                              <Badge variant="outline" className="border-red-500/30 text-red-400 bg-red-500/10">
                                Invalid Phone
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground max-w-[10rem] truncate">
                            {Object.entries(pRow.standardChanges)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(', ') || '—'}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground max-w-[12rem] truncate">
                            {Object.entries(pRow.customChanges)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(', ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: RESULT SCREEN */}
          {result && (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-background/50 p-4">
                <p className="text-sm font-medium text-popover-foreground">{t('importComplete')}</p>
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {result.updated > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                      <CheckCircle className="size-4 shrink-0" />
                      {t('resultUpdated', { count: result.updated })}
                    </div>
                  )}
                  {result.imported > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-primary font-medium">
                      <CheckCircle className="size-4 shrink-0" />
                      {t('resultImported', { count: result.imported })}
                    </div>
                  )}
                  {result.customFieldsUpdated > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-cyan-400 font-medium">
                      <CheckCircle className="size-4 shrink-0" />
                      {t('resultCustomUpdated', { count: result.customFieldsUpdated })}
                    </div>
                  )}
                  {result.unmatched > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                      <AlertTriangle className="size-4 shrink-0" />
                      {t('resultUnmatched', { count: result.unmatched })}
                    </div>
                  )}
                  {result.skipped > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <AlertTriangle className="size-4 shrink-0" />
                      {t('resultSkipped', { count: result.skipped })}
                    </div>
                  )}
                  {result.failed > 0 && (
                    <div className="flex items-center gap-1.5 text-xs text-red-400 font-medium">
                      <XCircle className="size-4 shrink-0" />
                      {t('resultFailed', { count: result.failed })}
                    </div>
                  )}
                </div>
              </div>

              {/* Unmatched list */}
              {result.unmatchedDetails.length > 0 && (
                <div className="rounded-xl border border-amber-500/20 bg-background/40 p-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                    {t('unmatchedRowsHeading')} ({result.unmatchedDetails.length})
                  </p>
                  <ul className="max-h-36 space-y-1.5 overflow-y-auto text-xs text-muted-foreground">
                    {result.unmatchedDetails.map((item, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-1">
                        <span className="font-mono text-popover-foreground">{item.phone}</span>
                        <span className="text-[11px] text-muted-foreground">{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Failed list */}
              {result.failedDetails.length > 0 && (
                <div className="rounded-xl border border-red-500/20 bg-background/40 p-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-red-400">
                    {t('failedRowsHeading')} ({result.failedDetails.length})
                  </p>
                  <ul className="max-h-36 space-y-1.5 overflow-y-auto text-xs text-muted-foreground">
                    {result.failedDetails.map((item, i) => (
                      <li key={i} className="flex items-baseline justify-between gap-2 border-b border-border/40 pb-1">
                        <span className="font-mono text-popover-foreground">{item.phone}</span>
                        <span className="text-[11px] text-red-400">{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Navigation */}
        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          {result ? (
            <Button
              type="button"
              onClick={() => handleOpenChange(false)}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {t('close')}
            </Button>
          ) : (
            <>
              {step !== 'file_mode' && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep(step === 'preview' ? 'mapping' : 'file_mode')}
                  disabled={importing || analyzing}
                  className="gap-1 border-border text-muted-foreground hover:bg-muted"
                >
                  <ChevronLeft className="size-3.5" />
                  {t('backBtn')}
                </Button>
              )}

              {step === 'file_mode' && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleOpenChange(false)}
                    className="border-border text-muted-foreground hover:bg-muted"
                  >
                    {t('cancel')}
                  </Button>
                  <Button
                    type="button"
                    disabled={csvRows.length === 0}
                    onClick={() => setStep('mapping')}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground gap-1"
                  >
                    <span>{t('nextBtn')}</span>
                    <ChevronRight className="size-3.5" />
                  </Button>
                </>
              )}

              {step === 'mapping' && (
                <Button
                  type="button"
                  onClick={handleGoToPreview}
                  disabled={analyzing}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground gap-1"
                >
                  {analyzing && <Loader2 className="size-3.5 animate-spin" />}
                  <span>{t('nextBtn')}</span>
                  <ChevronRight className="size-3.5" />
                </Button>
              )}

              {step === 'preview' && (
                <Button
                  type="button"
                  onClick={handleExecuteImport}
                  disabled={importing || (preflight?.totalRows ?? 0) === 0}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground gap-1.5"
                >
                  {importing && <Loader2 className="size-3.5 animate-spin" />}
                  {t('executeBtn', { count: preflight?.totalRows ?? csvRows.length })}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
