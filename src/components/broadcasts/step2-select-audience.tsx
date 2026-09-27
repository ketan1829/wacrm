'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { parseBroadcastCsv } from '@/lib/broadcast-csv';
import {
  type AudienceConfig,
  type CustomFieldCondition,
  type CustomFieldOperator,
  normalizeFilterConfig,
  resolveAudienceCount,
} from '@/lib/broadcast-audience';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Users,
  Tags,
  Filter,
  Upload,
  FileText,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const { accountId } = useAuth();
  const t = useTranslations('Broadcasts.wizard');

  const OPERATOR_OPTIONS = useMemo<{ value: CustomFieldOperator; label: string }[]>(
    () => [
      { value: 'is', label: t('selectAudience.operatorIs') || 'Equals' },
      { value: 'is_not', label: t('selectAudience.operatorIsNot') || 'Not equals' },
      { value: 'contains', label: t('selectAudience.operatorContains') || 'Contains' },
    ],
    [t],
  );

  const audienceOptions = useMemo<
    {
      type: AudienceType;
      label: string;
      description: string;
      icon: typeof Users;
    }[]
  >(
    () => [
      {
        type: 'all',
        label: t('selectAudience.method.all'),
        description: t('selectAudience.allDescLoading'),
        icon: Users,
      },
      {
        type: 'tags',
        label: t('selectAudience.method.tags'),
        description: t('selectAudience.tagDesc'),
        icon: Tags,
      },
      {
        type: 'custom_field',
        label: t('selectAudience.method.customField'),
        description: t('selectAudience.customFieldDesc'),
        icon: Filter,
      },
      {
        type: 'csv',
        label: t('selectAudience.method.csv'),
        description: t('selectAudience.csvDesc'),
        icon: Upload,
      },
    ],
    [t],
  );

  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [pickedCsvName, setPickedCsvName] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const csvCount = audience.csvContacts?.length ?? 0;
  const csvFileName = csvCount > 0 ? pickedCsvName : null;

  // Ensure custom field conditions exist in state
  const activeConditions = useMemo<CustomFieldCondition[]>(() => {
    if (audience.customFieldFilter?.conditions?.length) {
      return audience.customFieldFilter.conditions;
    }
    if (audience.customField?.fieldId) {
      return [
        {
          id: 'cond-0',
          fieldId: audience.customField.fieldId,
          operator: audience.customField.operator || 'is',
          value: audience.customField.value || '',
        },
      ];
    }
    return [
      {
        id: `cond-${Date.now()}`,
        fieldId: '',
        operator: 'is',
        value: '',
      },
    ];
  }, [audience.customFieldFilter, audience.customField]);

  const activeConjunction = audience.customFieldFilter?.conjunction || 'AND';

  // Load tags on mount
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  // Recalculate estimated reach using shared audience resolver
  const fetchEstimatedCount = useCallback(async () => {
    if (!accountId) return;
    setLoadingCount(true);
    try {
      const supabase = createClient();
      const count = await resolveAudienceCount(supabase, accountId, audience);
      setEstimatedCount(count);
    } catch (err) {
      console.error('Failed to calculate audience count:', err);
      setEstimatedCount(null);
    } finally {
      setLoadingCount(false);
    }
  }, [accountId, audience]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  async function handleCsvChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    const result = parseBroadcastCsv(await selected.text());

    if (!result.ok) {
      toast.error(
        result.error === 'missing_phone_column'
          ? t('selectAudience.errorCsvMissingPhone')
          : t('selectAudience.errorCsvParse'),
      );
      e.target.value = '';
      setPickedCsvName(null);
      onUpdate({ ...audience, csvContacts: undefined });
      return;
    }

    if (result.invalid > 0) {
      toast.warning(
        t('selectAudience.csvInvalidPhones', { count: result.invalid }),
      );
    }

    setPickedCsvName(selected.name);
    onUpdate({ ...audience, csvContacts: result.contacts });
  }

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  // Multi-condition updates
  function updateCondition(index: number, patch: Partial<CustomFieldCondition>) {
    const nextConditions = [...activeConditions];
    nextConditions[index] = { ...nextConditions[index], ...patch };
    const first = nextConditions[0];
    onUpdate({
      ...audience,
      customFieldFilter: {
        conjunction: activeConjunction,
        conditions: nextConditions,
      },
      customField: first?.fieldId
        ? { fieldId: first.fieldId, operator: first.operator, value: first.value }
        : undefined,
    });
  }

  function addCondition() {
    const nextConditions = [
      ...activeConditions,
      {
        id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fieldId: customFields[0]?.id || '',
        operator: 'is' as CustomFieldOperator,
        value: '',
      },
    ];
    onUpdate({
      ...audience,
      customFieldFilter: {
        conjunction: activeConjunction,
        conditions: nextConditions,
      },
    });
  }

  function removeCondition(index: number) {
    const nextConditions = activeConditions.filter((_, i) => i !== index);
    const fallback =
      nextConditions.length > 0
        ? nextConditions
        : [{ id: `cond-${Date.now()}`, fieldId: '', operator: 'is' as CustomFieldOperator, value: '' }];
    const first = fallback[0];
    onUpdate({
      ...audience,
      customFieldFilter: {
        conjunction: activeConjunction,
        conditions: fallback,
      },
      customField: first?.fieldId
        ? { fieldId: first.fieldId, operator: first.operator, value: first.value }
        : undefined,
    });
  }

  function toggleConjunction(conjunction: 'AND' | 'OR') {
    onUpdate({
      ...audience,
      customFieldFilter: {
        conjunction,
        conditions: activeConditions,
      },
    });
  }

  const normalizedCustom = normalizeFilterConfig(audience);
  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      normalizedCustom !== null &&
      normalizedCustom.conditions.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('selectAudience.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('selectAudience.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              type="button"
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  customFieldFilter:
                    option.type === 'custom_field'
                      ? audience.customFieldFilter
                      : undefined,
                  csvContacts:
                    option.type === 'csv' ? audience.csvContacts : undefined,
                })
              }
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border bg-card/50 hover:border-primary/40 hover:bg-card'
              }`}
            >
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">
                  {option.label}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Tags Filter */}
      {audience.type === 'tags' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <p className="text-sm font-medium text-foreground">
            {t('selectAudience.selectTags')}
          </p>
          {loadingTags ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = (audience.tagIds ?? []).includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      isSelected
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-muted/60 text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <span>{tag.name}</span>
                    {isSelected && <X className="h-3 w-3" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Multi-Condition Custom Field Filter */}
      {audience.type === 'custom_field' && (
        <div className="space-y-4 rounded-xl border border-border bg-card/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {t('selectAudience.method.customField')}
              </p>
              <p className="text-xs text-muted-foreground">
                Match contacts across multiple custom field rules.
              </p>
            </div>

            {/* Conjunction toggle (AND / OR) */}
            <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs">
              <button
                type="button"
                onClick={() => toggleConjunction('AND')}
                className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                  activeConjunction === 'AND'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Match ALL (AND)
              </button>
              <button
                type="button"
                onClick={() => toggleConjunction('OR')}
                className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                  activeConjunction === 'OR'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Match ANY (OR)
              </button>
            </div>
          </div>

          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="space-y-3">
              {activeConditions.map((cond, index) => (
                <div key={cond.id || `cond-${index}`}>
                  {index > 0 && (
                    <div className="my-2 flex items-center gap-2">
                      <div className="h-px flex-1 bg-border" />
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-primary">
                        {activeConjunction}
                      </span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  )}

                  <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_130px_minmax(0,1fr)_36px]">
                    <select
                      value={cond.fieldId}
                      onChange={(e) =>
                        updateCondition(index, { fieldId: e.target.value })
                      }
                      className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    >
                      <option value="">{t('selectAudience.selectField')}</option>
                      {customFields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.field_name}
                        </option>
                      ))}
                    </select>

                    <select
                      value={cond.operator}
                      onChange={(e) =>
                        updateCondition(index, {
                          operator: e.target.value as CustomFieldOperator,
                        })
                      }
                      className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    >
                      {OPERATOR_OPTIONS.map((op) => (
                        <option key={op.value} value={op.value}>
                          {op.label}
                        </option>
                      ))}
                    </select>

                    <input
                      type="text"
                      value={cond.value}
                      onChange={(e) =>
                        updateCondition(index, { value: e.target.value })
                      }
                      placeholder={t('selectAudience.valuePlaceholder')}
                      className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                    />

                    {activeConditions.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeCondition(index)}
                        className="h-9 w-9 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : (
                      <div className="h-9 w-9" />
                    )}
                  </div>
                </div>
              ))}

              <div className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addCondition}
                  className="h-8 gap-1.5 border-dashed border-border text-xs text-foreground hover:bg-muted"
                >
                  <Plus className="h-3.5 w-3.5 text-primary" />
                  + Add condition
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* CSV Upload */}
      {audience.type === 'csv' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t('selectAudience.uploadCsv')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('selectAudience.csvFormatDesc')}
            </p>
          </div>

          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="group flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-center transition-colors hover:border-primary/40 hover:bg-muted/70"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:text-foreground">
              {csvFileName ? (
                <FileText className="h-5 w-5" />
              ) : (
                <Upload className="h-5 w-5" />
              )}
            </div>
            <p className="text-sm text-foreground">
              {csvFileName ?? t('selectAudience.uploadCsv')}
            </p>
            {csvCount > 0 && (
              <p className="text-xs text-primary">
                {t('selectAudience.csvContactsFound', { count: csvCount })}
              </p>
            )}
          </button>

          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvChange}
            className="hidden"
          />
        </div>
      )}

      {/* Optional Exclude Tags (for non-CSV) */}
      {audience.type !== 'csv' && tags.length > 0 && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {t('selectAudience.excludeTags')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Contacts with these tags will be omitted from this broadcast.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = (audience.excludeTagIds ?? []).includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    isExcluded
                      ? 'border-destructive bg-destructive/10 text-destructive'
                      : 'border-border bg-muted/60 text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <span>{tag.name}</span>
                  {isExcluded && <X className="h-3 w-3" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Audience Reach Summary Counter */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
        <div>
          <p className="text-sm font-medium text-foreground">Estimated Audience Reach</p>
          <p className="text-xs text-muted-foreground">
            Contacts matching all criteria that will receive this message.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loadingCount ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <div className="flex items-center gap-1.5">
              <Users className="h-4 w-4 text-primary" />
              <span className="text-lg font-bold text-foreground tabular-nums">
                {estimatedCount !== null ? estimatedCount.toLocaleString() : '—'}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
