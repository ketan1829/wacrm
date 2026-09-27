'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  ImageIcon,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Database,
  User,
  Type,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PersonalizeMenu } from './personalize-menu';
import {
  type VariableMapping,
  type VariableType,
  validatePersonalization,
  renderTemplatePreview,
} from '@/lib/broadcast-variables';
import {
  type AudienceConfig,
  resolveAudience,
  fetchCustomValueIndex,
  type CustomValueIndex,
} from '@/lib/broadcast-audience';

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  headerMediaUrl: string;
  onHeaderMediaUrlChange: (url: string) => void;
  audience?: AudienceConfig;
  onNext: () => void;
  onBack: () => void;
}

const MEDIA_HEADER_TYPES = ['image', 'video', 'document'] as const;
type MediaHeaderType = (typeof MEDIA_HEADER_TYPES)[number];

function isMediaHeaderType(value: unknown): value is MediaHeaderType {
  return MEDIA_HEADER_TYPES.includes(value as MediaHeaderType);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  account_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerMediaUrl,
  onHeaderMediaUrlChange,
  audience,
  onNext,
  onBack,
}: Step3Props) {
  const { accountId } = useAuth();
  const t = useTranslations('Broadcasts.wizard');

  const [customFields, setCustomFields] = useState<CustomField[]>([]);

  // Audience sample contacts for real preview & validation
  const [previewContacts, setPreviewContacts] = useState<Contact[]>([]);
  const [customValueIndex, setCustomValueIndex] = useState<CustomValueIndex>(new Map());
  const [previewIndex, setPreviewIndex] = useState(0);

  // Load custom fields & preview contacts
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!accountId) return;
      const supabase = createClient();

      try {
        const { data: fields } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');

        if (cancelled) return;
        setCustomFields(fields ?? []);

        let contacts: Contact[] = [];
        if (audience) {
          try {
            contacts = await resolveAudience(supabase, accountId, audience);
          } catch {
            // Fallback to recent contacts if audience resolve fails
          }
        }

        if (contacts.length === 0) {
          const { data: recent } = await supabase
            .from('contacts')
            .select('*')
            .eq('account_id', accountId)
            .order('created_at', { ascending: false })
            .limit(10);
          contacts = recent ?? [];
        }

        if (cancelled) return;
        const sampleSet = contacts.slice(0, 10);
        setPreviewContacts(sampleSet);

        if (sampleSet.length > 0) {
          const cIndex = await fetchCustomValueIndex(
            supabase,
            sampleSet.map((c) => c.id),
          );
          if (!cancelled) setCustomValueIndex(cIndex);
        }
      } catch (err) {
        console.error('Failed to load personalization data:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, audience]);

  // Extract {{1}}, {{2}}...
  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)].sort((a, b) => {
      const an = Number(a.replace(/\D/g, ''));
      const bn = Number(b.replace(/\D/g, ''));
      return an - bn;
    });
  }, [template.body_text]);

  const mediaHeaderType = isMediaHeaderType(template.header_type)
    ? template.header_type
    : null;

  useEffect(() => {
    if (mediaHeaderType && !headerMediaUrl && template.header_media_url) {
      onHeaderMediaUrlChange(template.header_media_url);
    }
  }, [mediaHeaderType, template.header_media_url, headerMediaUrl, onHeaderMediaUrlChange]);

  const headerMediaError = useMemo<'missing' | 'invalid' | null>(() => {
    if (!mediaHeaderType) return null;
    const value = headerMediaUrl.trim();
    if (!value) return 'missing';
    if (!isValidHttpUrl(value)) return 'invalid';
    return null;
  }, [mediaHeaderType, headerMediaUrl]);

  // Check which keys are unmapped
  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholder.replace(/^\{\{|\}\}$/g, '');
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? { type: 'static' as VariableType, value: '' };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  // Active preview contact
  const currentPreviewContact = previewContacts[previewIndex] ?? SAMPLE_CONTACT;
  const currentContactCustoms = customValueIndex.get(currentPreviewContact.id);

  // Live preview text rendered with single source of truth
  const previewText = useMemo(() => {
    return renderTemplatePreview(
      template.body_text,
      placeholders,
      variables,
      currentPreviewContact,
      currentContactCustoms,
    );
  }, [template.body_text, placeholders, variables, currentPreviewContact, currentContactCustoms]);

  // Validation report
  const validationResult = useMemo(() => {
    if (previewContacts.length === 0) return null;
    return validatePersonalization(
      previewContacts,
      placeholders,
      variables,
      customValueIndex,
    );
  }, [previewContacts, placeholders, variables, customValueIndex]);

  const customFieldMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of customFields) {
      map.set(f.id, f.field_name);
    }
    return map;
  }, [customFields]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('personalize.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('personalize.subtitle')}
        </p>
      </div>

      {/* Header Media URL if required */}
      {mediaHeaderType && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">
              {t('personalize.headerImage')}
            </p>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium uppercase text-primary">
              {mediaHeaderType}
            </span>
          </div>
          <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
            {t('personalize.imageUrl')}
          </label>
          <Input
            type="url"
            value={headerMediaUrl}
            onChange={(e) => onHeaderMediaUrlChange(e.target.value)}
            placeholder={t('personalize.imageUrlPlaceholder')}
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t('personalize.headerImageDesc')}
          </p>
          {mediaHeaderType === 'image' &&
            headerMediaError === null &&
            headerMediaUrl.trim() && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl.trim()}
                alt={t('personalize.headerPreviewAlt')}
                className="mt-3 max-h-40 rounded-lg border border-border object-contain"
              />
            )}
          {headerMediaError && (
            <p className="mt-1.5 text-xs text-amber-400">
              {headerMediaError === 'missing'
                ? t('personalize.mediaUrlRequired')
                : t('personalize.mediaUrlInvalid')}
            </p>
          )}
        </div>
      )}

      {/* Placeholders Mapping Section */}
      {placeholders.length === 0 && !mediaHeaderType ? (
        <div className="rounded-xl border border-border bg-card/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('personalize.noPreview')}
          </p>
        </div>
      ) : placeholders.length === 0 ? null : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              Template Variables ({placeholders.length})
            </h3>
            {unmappedKeys.length > 0 && (
              <span className="text-xs text-amber-400">
                {unmappedKeys.length} unmapped variable{unmappedKeys.length > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {placeholders.map((placeholder) => {
            const key = placeholder.replace(/^\{\{|\}\}$/g, '');
            const mapping = variables[key] ?? { type: 'static', value: '' };

            const isMapped = Boolean(mapping.value?.trim());
            const displayLabel =
              mapping.type === 'field'
                ? mapping.value.charAt(0).toUpperCase() + mapping.value.slice(1)
                : mapping.type === 'custom_field'
                  ? customFieldMap.get(mapping.value) || 'Custom Field'
                  : mapping.value || 'Not mapped';

            return (
              <div
                key={placeholder}
                className="space-y-3 rounded-xl border border-border bg-card/50 p-4 transition-colors hover:border-border/80"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
                      {placeholder}
                    </span>

                    {/* Token / Chip Display */}
                    {isMapped ? (
                      <Badge
                        variant="secondary"
                        className={`gap-1.5 text-xs font-medium ${
                          mapping.type === 'custom_field'
                            ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                            : mapping.type === 'field'
                              ? 'bg-primary/10 text-primary border border-primary/20'
                              : 'bg-muted text-foreground border border-border'
                        }`}
                      >
                        {mapping.type === 'custom_field' && <Database className="h-3 w-3" />}
                        {mapping.type === 'field' && <User className="h-3 w-3" />}
                        {mapping.type === 'static' && <Type className="h-3 w-3" />}
                        <span>{displayLabel}</span>
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">
                        Click Personalize to assign a field
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Searchable + Personalize Menu */}
                    <PersonalizeMenu
                      customFields={customFields}
                      onSelect={(item) =>
                        updateVariable(key, {
                          type: item.type,
                          value: item.value,
                        })
                      }
                      triggerLabel="+ Personalize"
                    />

                    {/* Switch to static text */}
                    {mapping.type !== 'static' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => updateVariable(key, { type: 'static', value: '' })}
                        className="h-8 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Static text
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => updateVariable(key, { type: 'field', value: 'name' })}
                        className="h-8 text-xs text-muted-foreground hover:text-foreground"
                      >
                        Dynamic field
                      </Button>
                    )}
                  </div>
                </div>

                {/* Input row for static value or fallback */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {mapping.type === 'static' ? (
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Static Value
                      </label>
                      <Input
                        value={mapping.value}
                        onChange={(e) => updateVariable(key, { value: e.target.value })}
                        placeholder="Enter static text..."
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Fallback Value (Optional)
                      </label>
                      <Input
                        value={mapping.fallback ?? ''}
                        onChange={(e) => updateVariable(key, { fallback: e.target.value })}
                        placeholder="e.g. Valued Customer"
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Used if a contact is missing this value.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Validation Warning Alert (if missing values detected) */}
      {validationResult && validationResult.missingCount > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-200">
                Missing Values Detected ({validationResult.missingCount} of{' '}
                {validationResult.totalContacts} sample contacts)
              </p>
              <p className="text-xs text-amber-300/90">
                Variables missing data:{' '}
                <span className="font-mono font-medium">
                  {validationResult.missingPlaceholders.join(', ')}
                </span>
                . You can supply fallback values above, or select &quot;Exclude these contacts&quot; in the final review step.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Live Preview with Real Contact Data */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-primary" />
            <p className="text-sm font-medium text-foreground">Message Preview</p>
          </div>

          {previewContacts.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Preview as:</span>
              <div className="flex items-center gap-1 rounded-lg border border-border bg-muted px-2 py-1">
                <span className="font-medium text-foreground">
                  {currentPreviewContact.name || currentPreviewContact.phone}
                </span>
                <span className="text-muted-foreground">
                  ({previewIndex + 1}/{previewContacts.length})
                </span>
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={previewIndex <= 0}
                  onClick={() => setPreviewIndex((prev) => Math.max(0, prev - 1))}
                  className="h-7 w-7 text-muted-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={previewIndex >= previewContacts.length - 1}
                  onClick={() =>
                    setPreviewIndex((prev) =>
                      Math.min(previewContacts.length - 1, prev + 1),
                    )
                  }
                  className="h-7 w-7 text-muted-foreground"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* WhatsApp-Style Message Bubble */}
        <div className="rounded-lg bg-muted/40 p-4">
          <div className="max-w-md rounded-lg bg-card border border-border p-3 shadow-sm space-y-2">
            {headerMediaUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={headerMediaUrl}
                alt="Header"
                className="max-h-36 w-full rounded object-cover"
              />
            )}
            <p className="text-sm whitespace-pre-wrap text-foreground font-normal leading-relaxed">
              {previewText}
            </p>
            <div className="flex justify-end">
              <span className="text-[10px] text-muted-foreground">
                {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
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
          disabled={unmappedKeys.length > 0 || headerMediaError !== null}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
