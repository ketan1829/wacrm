'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  Loader2,
  Users,
  Save,
  Calendar,
  AlertTriangle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type AudienceConfig,
  resolveAudienceCount,
  resolveAudience,
  fetchCustomValueIndex,
} from '@/lib/broadcast-audience';
import {
  type VariableMapping,
  type MissingValuePolicy,
  validatePersonalization,
  PersonalizationValidationResult,
} from '@/lib/broadcast-variables';

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
  sendMode: 'now' | 'schedule';
  onSendModeChange: (mode: 'now' | 'schedule') => void;
  scheduledDate: string;
  onScheduledDateChange: (date: string) => void;
  scheduledTime: string;
  onScheduledTimeChange: (time: string) => void;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
  missingPolicy: MissingValuePolicy;
  onMissingPolicyChange: (policy: MissingValuePolicy) => void;
  globalFallback: string;
  onGlobalFallbackChange: (fallback: string) => void;
  onSendNow: () => void;
  onSchedule: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Australia/Sydney',
];

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  variables,
  headerMediaUrl,
  sendMode,
  onSendModeChange,
  scheduledDate,
  onScheduledDateChange,
  scheduledTime,
  onScheduledTimeChange,
  timezone,
  onTimezoneChange,
  missingPolicy,
  onMissingPolicyChange,
  globalFallback,
  onGlobalFallbackChange,
  onSendNow,
  onSchedule,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const { accountId } = useAuth();
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const [validationResult, setValidationResult] =
    useState<PersonalizationValidationResult | null>(null);

  // Today string for date input min
  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], []);

  // Timezone options (including user's current timezone)
  const timezoneOptions = useMemo(() => {
    const list = [...COMMON_TIMEZONES];
    if (timezone && !list.includes(timezone)) {
      list.unshift(timezone);
    }
    return list;
  }, [timezone]);

  // Extract template placeholders
  const placeholders = useMemo(() => {
    const matches = template.body_text.match(/\{\{(\d+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches)];
  }, [template.body_text]);

  useEffect(() => {
    async function calculateReach() {
      if (!accountId) return;
      setLoadingReach(true);
      try {
        const supabase = createClient();
        const count = await resolveAudienceCount(supabase, accountId, audience);
        setEstimatedReach(count);

        // Fetch small sample to validate missing variables
        const sample = await resolveAudience(supabase, accountId, audience);
        if (sample.length > 0 && placeholders.length > 0) {
          const cIndex = await fetchCustomValueIndex(
            supabase,
            sample.slice(0, 50).map((c) => c.id),
          );
          const validation = validatePersonalization(
            sample.slice(0, 50),
            placeholders,
            variables,
            cIndex,
          );
          setValidationResult(validation);
        } else {
          setValidationResult(null);
        }
      } catch (err) {
        console.error('Reach calculation failed:', err);
        setEstimatedReach(0);
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [accountId, audience, variables, placeholders]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  const isScheduleValid = useMemo(() => {
    if (sendMode === 'now') return true;
    if (!scheduledDate || !scheduledTime) return false;
    const sched = new Date(`${scheduledDate}T${scheduledTime}:00`);
    return sched.getTime() > Date.now();
  }, [sendMode, scheduledDate, scheduledTime]);

  const effectiveReach = useMemo(() => {
    if (
      missingPolicy === 'exclude' &&
      validationResult &&
      validationResult.totalContacts > 0 &&
      validationResult.missingCount > 0
    ) {
      const missingRatio =
        validationResult.missingCount / validationResult.totalContacts;
      const estimatedExcluded = Math.round(estimatedReach * missingRatio);
      return Math.max(0, estimatedReach - estimatedExcluded);
    }
    return estimatedReach;
  }, [missingPolicy, validationResult, estimatedReach]);

  function handleFinalSubmit() {
    setShowConfirm(false);
    if (sendMode === 'now') {
      onSendNow();
    } else {
      onSchedule();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('scheduleSend.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review your broadcast settings, personalize fallback options, and choose when to send.
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t('scheduleSend.broadcastName')}
        </label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="font-medium text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="font-medium text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">
                    {effectiveReach.toLocaleString()} contacts
                    {missingPolicy === 'exclude' && effectiveReach !== estimatedReach && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        (filtered from {estimatedReach.toLocaleString()})
                      </span>
                    )}
                  </p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="font-medium text-foreground">{template.language ?? 'en_US'}</p>
          </div>
          {headerMediaUrl && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">Header Media</p>
              <p className="font-mono text-xs text-foreground truncate">{headerMediaUrl}</p>
            </div>
          )}
        </div>
      </div>

      {/* Missing Values Handling Policy */}
      {placeholders.length > 0 && (
        <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">
              Missing Value Handling
            </p>
            <p className="text-xs text-muted-foreground">
              What should happen if a contact does not have a value for a personalized variable?
            </p>
          </div>

          {validationResult && validationResult.missingCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>
                Estimated ~{Math.round((validationResult.missingCount / validationResult.totalContacts) * 100)}% of contacts are missing at least one variable value.
              </span>
            </div>
          )}

          <div className="space-y-2">
            <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/40">
              <input
                type="radio"
                name="missingPolicy"
                checked={missingPolicy === 'blank'}
                onChange={() => onMissingPolicyChange('blank')}
                className="mt-0.5 text-primary"
              />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Send anyway with blank value
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Empty string is sent for missing variables.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/40">
              <input
                type="radio"
                name="missingPolicy"
                checked={missingPolicy === 'fallback'}
                onChange={() => onMissingPolicyChange('fallback')}
                className="mt-0.5 text-primary"
              />
              <div className="flex-1">
                <p className="text-xs font-medium text-foreground">
                  Use fallback value
                </p>
                <p className="text-[11px] text-muted-foreground mb-2">
                  Substitute a default word or phrase if the contact has no value.
                </p>
                {missingPolicy === 'fallback' && (
                  <Input
                    value={globalFallback}
                    onChange={(e) => onGlobalFallbackChange(e.target.value)}
                    placeholder="e.g. there, valued customer"
                    className="h-8 text-xs border-border bg-muted"
                  />
                )}
              </div>
            </label>

            <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/40">
              <input
                type="radio"
                name="missingPolicy"
                checked={missingPolicy === 'exclude'}
                onChange={() => onMissingPolicyChange('exclude')}
                className="mt-0.5 text-primary"
              />
              <div>
                <p className="text-xs font-medium text-foreground">
                  Exclude these contacts
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Contacts with missing custom-field values will be safely skipped.
                </p>
              </div>
            </label>
          </div>
        </div>
      )}

      {/* Timing: Send Now vs Schedule for Later */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-4">
        <div>
          <p className="text-sm font-medium text-foreground">
            When should this broadcast be sent?
          </p>
          <p className="text-xs text-muted-foreground">
            Choose whether to deliver immediately or schedule for a future date and time.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label
            className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${
              sendMode === 'now'
                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                : 'border-border bg-card hover:border-primary/40'
            }`}
          >
            <input
              type="radio"
              name="sendMode"
              checked={sendMode === 'now'}
              onChange={() => onSendModeChange('now')}
              className="mt-1 text-primary"
            />
            <div>
              <div className="flex items-center gap-1.5 font-medium text-sm text-foreground">
                <Send className="h-3.5 w-3.5 text-primary" />
                <span>Send now</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Start delivering immediately once confirmed.
              </p>
            </div>
          </label>

          <label
            className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer transition-all ${
              sendMode === 'schedule'
                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                : 'border-border bg-card hover:border-primary/40'
            }`}
          >
            <input
              type="radio"
              name="sendMode"
              checked={sendMode === 'schedule'}
              onChange={() => onSendModeChange('schedule')}
              className="mt-1 text-primary"
            />
            <div>
              <div className="flex items-center gap-1.5 font-medium text-sm text-foreground">
                <Calendar className="h-3.5 w-3.5 text-primary" />
                <span>Schedule for later</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Automatically deliver at a specified future date and time.
              </p>
            </div>
          </label>
        </div>

        {/* Schedule Inputs */}
        {sendMode === 'schedule' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-border">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Date
              </label>
              <div className="relative">
                <Input
                  type="date"
                  min={todayStr}
                  value={scheduledDate}
                  onChange={(e) => onScheduledDateChange(e.target.value)}
                  className="border-border bg-muted text-foreground text-xs"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Time
              </label>
              <div className="relative">
                <Input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => onScheduledTimeChange(e.target.value)}
                  className="border-border bg-muted text-foreground text-xs"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Timezone
              </label>
              <select
                value={timezone}
                onChange={(e) => onTimezoneChange(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Progress display during sending */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">
                {sendMode === 'schedule' ? 'Scheduling broadcast...' : t('scheduleSend.sending')}
              </p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Navigation & Action Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Button
            onClick={() => setShowConfirm(true)}
            disabled={!name.trim() || !isScheduleValid || isProcessing || effectiveReach === 0}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {sendMode === 'now' ? (
              <>
                <Send className="h-4 w-4" />
                {t('scheduleSend.sendNow')}
              </>
            ) : (
              <>
                <Calendar className="h-4 w-4" />
                Schedule Broadcast
              </>
            )}
          </Button>

          {/* Final Review & Confirmation Dialog */}
          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {sendMode === 'now' ? 'Confirm Immediate Broadcast' : 'Confirm Scheduled Broadcast'}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground text-xs pt-1 space-y-2">
                  <p>
                    You are about to {sendMode === 'now' ? 'send' : 'schedule'} this broadcast to{' '}
                    <strong className="text-foreground">{effectiveReach.toLocaleString()} contacts</strong>{' '}
                    using template <strong className="text-foreground">{template.name}</strong>.
                  </p>
                  {sendMode === 'schedule' && (
                    <p className="rounded bg-muted p-2 text-foreground font-medium">
                      Scheduled for: {scheduledDate} at {scheduledTime} ({timezone})
                    </p>
                  )}
                  {missingPolicy === 'exclude' && effectiveReach !== estimatedReach && (
                    <p className="text-amber-400">
                      Note: {estimatedReach - effectiveReach} contacts missing custom variables will be excluded.
                    </p>
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={handleFinalSubmit}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {sendMode === 'now' ? (
                    <>
                      <Send className="h-4 w-4 mr-1.5" />
                      Send Now
                    </>
                  ) : (
                    <>
                      <Calendar className="h-4 w-4 mr-1.5" />
                      Confirm Schedule
                    </>
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
