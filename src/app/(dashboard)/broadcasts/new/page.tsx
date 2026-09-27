'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { type AudienceConfig } from '@/lib/broadcast-audience';
import { type VariableMapping, type MissingValuePolicy } from '@/lib/broadcast-variables';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

function NewBroadcastWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const draftIdParam = searchParams.get('draftId') || searchParams.get('draft');
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const {
    createAndSendBroadcast,
    scheduleBroadcast,
    saveDraftBroadcast,
    isProcessing,
    progress,
  } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [draftId, setDraftId] = useState<string | null>(draftIdParam);
  const [loadingDraft, setLoadingDraft] = useState(Boolean(draftIdParam));
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<Record<string, VariableMapping>>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  // Scheduling & Timing
  const [sendMode, setSendMode] = useState<'now' | 'schedule'>('now');
  const [scheduledDate, setScheduledDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  });
  const [scheduledTime, setScheduledTime] = useState('10:00');
  const [timezone, setTimezone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  });

  // Missing variable handling policy
  const [missingPolicy, setMissingPolicy] = useState<MissingValuePolicy>('exclude');
  const [globalFallback, setGlobalFallback] = useState('');

  // Load existing draft if draftId is supplied
  useEffect(() => {
    if (!draftIdParam || !accountId) return;

    let cancelled = false;
    async function loadDraft() {
      setLoadingDraft(true);
      const supabase = createClient();
      try {
        const { data: bc, error } = await supabase
          .from('broadcasts')
          .select('*')
          .eq('id', draftIdParam)
          .eq('account_id', accountId)
          .maybeSingle();

        if (error || !bc) {
          toast.error('Draft not found or could not be loaded.');
          return;
        }

        if (cancelled) return;
        setDraftId(bc.id);
        setName(bc.name || '');
        if (bc.header_media_url) setHeaderMediaUrl(bc.header_media_url);
        if (bc.template_variables) setVariables(bc.template_variables as Record<string, VariableMapping>);
        if (bc.audience_filter) setAudience(bc.audience_filter as AudienceConfig);
        if (bc.timezone) setTimezone(bc.timezone);

        if (bc.scheduled_at) {
          setSendMode('schedule');
          const d = new Date(bc.scheduled_at);
          setScheduledDate(d.toISOString().split('T')[0]);
          setScheduledTime(d.toTimeString().slice(0, 5));
        }

        // Fetch corresponding template
        if (bc.template_name) {
          const { data: tmpl } = await supabase
            .from('message_templates')
            .select('*')
            .eq('account_id', accountId)
            .eq('name', bc.template_name)
            .maybeSingle();

          if (tmpl && !cancelled) {
            setTemplate(tmpl);
          }
        }
      } catch (err) {
        console.error('Error loading draft:', err);
      } finally {
        if (!cancelled) setLoadingDraft(false);
      }
    }

    loadDraft();
    return () => {
      cancelled = true;
    };
  }, [draftIdParam, accountId]);

  async function handleSendNow() {
    if (!template) return;
    try {
      const broadcastId = await createAndSendBroadcast({
        broadcastId: draftId || undefined,
        name,
        template,
        audience,
        variables,
        headerMediaUrl,
        missingValuePolicy: missingPolicy,
        fallbackValue: globalFallback,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast send error:', err);
      toast.error(message);
    }
  }

  async function handleSchedule() {
    if (!template) return;
    try {
      const sched = new Date(`${scheduledDate}T${scheduledTime}:00`);
      const broadcastId = await scheduleBroadcast({
        broadcastId: draftId || undefined,
        name,
        template,
        audience,
        variables,
        headerMediaUrl,
        scheduledAt: sched.toISOString(),
        timezone,
        missingValuePolicy: missingPolicy,
        fallbackValue: globalFallback,
      });
      toast.success('Broadcast scheduled successfully');
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scheduling failed';
      console.error('Broadcast schedule error:', err);
      toast.error(message);
    }
  }

  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    try {
      await saveDraftBroadcast({
        broadcastId: draftId || undefined,
        name,
        template,
        audience,
        variables,
        headerMediaUrl,
        timezone,
      });
      toast.success(t('toastDraftSaved'));
      router.push('/broadcasts');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save draft';
      console.error('Broadcast draft error:', err);
      toast.error(message);
    }
  }

  if (loadingDraft) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-foreground">
            {draftId ? 'Edit Broadcast Draft' : t('title')}
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {draftId
            ? 'Update your message, audience, and schedule before sending.'
            : t('subtitle')}
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive
                      ? 'text-foreground'
                      : isCompleted
                        ? 'text-primary'
                        : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              audience={audience}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              variables={variables}
              headerMediaUrl={headerMediaUrl}
              sendMode={sendMode}
              onSendModeChange={setSendMode}
              scheduledDate={scheduledDate}
              onScheduledDateChange={setScheduledDate}
              scheduledTime={scheduledTime}
              onScheduledTimeChange={setScheduledTime}
              timezone={timezone}
              onTimezoneChange={setTimezone}
              missingPolicy={missingPolicy}
              onMissingPolicyChange={setMissingPolicy}
              globalFallback={globalFallback}
              onGlobalFallbackChange={setGlobalFallback}
              onSendNow={handleSendNow}
              onSchedule={handleSchedule}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function NewBroadcastPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      }
    >
      <NewBroadcastWizard />
    </Suspense>
  );
}
