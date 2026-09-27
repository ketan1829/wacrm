'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import {
  resolveAudience,
  resolveAudienceCount,
  fetchCustomValueIndex,
  type AudienceConfig,
  type CustomFieldFilterConfig,
  type CustomFieldOperator,
  type CustomValueIndex,
} from '@/lib/broadcast-audience';
import {
  resolveVariables,
  validatePersonalization,
  filterContactsByMissingPolicy,
  type VariableMapping,
  type MissingValuePolicy,
} from '@/lib/broadcast-variables';
import { MessageTemplate } from '@/types';

export type {
  AudienceConfig,
  CustomFieldFilterConfig,
  CustomFieldOperator,
  VariableMapping,
  MissingValuePolicy,
  CustomValueIndex,
};

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface BroadcastPayload {
  /** Optional: set when sending or updating an existing saved draft */
  broadcastId?: string;
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header */
  headerMediaUrl?: string;
  /** ISO timestamp for scheduled execution */
  scheduledAt?: string | null;
  /** Timezone name e.g. 'Asia/Kolkata', 'America/New_York' */
  timezone?: string;
  /** Handling policy for missing custom values ('blank' | 'fallback' | 'exclude') */
  missingValuePolicy?: MissingValuePolicy;
  /** Optional fallback value */
  fallbackValue?: string;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  scheduleBroadcast: (payload: BroadcastPayload) => Promise<string>;
  saveDraftBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

export { resolveVariables };

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function scheduleBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);
    const supabase = createClient();

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('You are not signed in.');
      if (!accountId) throw new Error('Your profile is not linked to an account.');

      setProgress(10);
      let contacts = await resolveAudience(
        supabase,
        accountId,
        payload.audience,
        user.id,
      );

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      setProgress(25);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id),
      );

      if (payload.missingValuePolicy === 'exclude') {
        const placeholders = Object.keys(payload.variables).map((k) => `{{${k}}}`);
        const validation = validatePersonalization(
          contacts,
          placeholders,
          payload.variables,
          customValueIndex,
        );
        contacts = filterContactsByMissingPolicy(contacts, validation, 'exclude');
        if (contacts.length === 0) {
          throw new Error('All contacts were excluded due to missing variable values.');
        }
      }

      const broadcastData = {
        user_id: user.id,
        account_id: accountId,
        name: payload.name.trim(),
        template_name: payload.template.name,
        template_language: payload.template.language ?? 'en_US',
        template_variables: payload.variables,
        audience_filter: payload.audience as unknown as Record<string, unknown>,
        header_media_url: payload.headerMediaUrl?.trim() || null,
        scheduled_at: payload.scheduledAt,
        timezone: payload.timezone || 'UTC',
        status: 'scheduled' as const,
        total_recipients: contacts.length,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
        updated_at: new Date().toISOString(),
      };

      let broadcastId = payload.broadcastId;
      if (broadcastId) {
        const { error: updateErr } = await supabase
          .from('broadcasts')
          .update(broadcastData)
          .eq('id', broadcastId);
        if (updateErr) {
          throw new Error(`Failed to schedule broadcast: ${updateErr.message}`);
        }
        await supabase
          .from('broadcast_recipients')
          .delete()
          .eq('broadcast_id', broadcastId);
      } else {
        const { data: created, error: createErr } = await supabase
          .from('broadcasts')
          .insert(broadcastData)
          .select()
          .single();
        if (createErr || !created) {
          throw new Error(
            `Failed to schedule broadcast: ${createErr?.message ?? 'unknown error'}`,
          );
        }
        broadcastId = created.id;
      }

      setProgress(50);
      const paramsByContact = new Map(
        contacts.map((contact) => [
          contact.id,
          resolveVariables(
            payload.variables,
            contact,
            customValueIndex.get(contact.id),
            payload.missingValuePolicy,
            payload.fallbackValue,
          ),
        ]),
      );

      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcastId!,
        contact_id: contact.id,
        status: 'pending' as const,
        template_params: paramsByContact.get(contact.id) ?? [],
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          throw new Error(
            `Failed to insert scheduled recipients: ${recipientError.message}`,
          );
        }
      }

      setProgress(100);
      return broadcastId!;
    } finally {
      setIsProcessing(false);
    }
  }

  async function saveDraftBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    const supabase = createClient();

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('You are not signed in.');
      if (!accountId) throw new Error('Your profile is not linked to an account.');

      let count = 0;
      try {
        count = await resolveAudienceCount(supabase, accountId, payload.audience);
      } catch {
        // Fall back to 0 if audience calculation fails in partial draft state
      }

      const broadcastData = {
        user_id: user.id,
        account_id: accountId,
        name: payload.name.trim(),
        template_name: payload.template.name,
        template_language: payload.template.language ?? 'en_US',
        template_variables: payload.variables,
        audience_filter: payload.audience as unknown as Record<string, unknown>,
        header_media_url: payload.headerMediaUrl?.trim() || null,
        scheduled_at: null,
        timezone: payload.timezone || 'UTC',
        status: 'draft' as const,
        total_recipients: count,
        updated_at: new Date().toISOString(),
      };

      let broadcastId = payload.broadcastId;
      if (broadcastId) {
        const { error: updateErr } = await supabase
          .from('broadcasts')
          .update(broadcastData)
          .eq('id', broadcastId);
        if (updateErr) {
          throw new Error(`Failed to save draft: ${updateErr.message}`);
        }
      } else {
        const { data: created, error: createErr } = await supabase
          .from('broadcasts')
          .insert({
            ...broadcastData,
            sent_count: 0,
            delivered_count: 0,
            read_count: 0,
            replied_count: 0,
            failed_count: 0,
          })
          .select()
          .single();
        if (createErr || !created) {
          throw new Error(
            `Failed to create draft: ${createErr?.message ?? 'unknown error'}`,
          );
        }
        broadcastId = created.id;
      }

      return broadcastId!;
    } finally {
      setIsProcessing(false);
    }
  }

  async function createAndSendBroadcast(
    payload: BroadcastPayload,
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);
    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      let contacts = await resolveAudience(
        supabase,
        accountId,
        payload.audience,
        user.id,
      );

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Fetch custom values & apply missing policy ────────
      setProgress(12);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id),
      );

      if (payload.missingValuePolicy === 'exclude') {
        const placeholders = Object.keys(payload.variables).map((k) => `{{${k}}}`);
        const validation = validatePersonalization(
          contacts,
          placeholders,
          payload.variables,
          customValueIndex,
        );
        contacts = filterContactsByMissingPolicy(contacts, validation, 'exclude');
        if (contacts.length === 0) {
          throw new Error('All contacts were excluded due to missing variable values.');
        }
      }

      // ── Step 3: Insert or update broadcast row ────────────────────
      setProgress(18);
      const broadcastData = {
        user_id: user.id,
        account_id: accountId,
        name: payload.name.trim(),
        template_name: payload.template.name,
        template_language: payload.template.language ?? 'en_US',
        template_variables: payload.variables,
        audience_filter: payload.audience as unknown as Record<string, unknown>,
        header_media_url: payload.headerMediaUrl?.trim() || null,
        scheduled_at: null,
        timezone: payload.timezone || 'UTC',
        status: 'sending' as const,
        total_recipients: contacts.length,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
        updated_at: new Date().toISOString(),
      };

      let broadcastId = payload.broadcastId;
      if (broadcastId) {
        const { error: updateErr } = await supabase
          .from('broadcasts')
          .update(broadcastData)
          .eq('id', broadcastId);
        if (updateErr) {
          throw new Error(`Failed to update broadcast: ${updateErr.message}`);
        }
        // Remove stale pending recipient rows from prior draft/schedule attempts
        await supabase
          .from('broadcast_recipients')
          .delete()
          .eq('broadcast_id', broadcastId);
      } else {
        const { data: created, error: createErr } = await supabase
          .from('broadcasts')
          .insert(broadcastData)
          .select()
          .single();

        if (createErr || !created) {
          throw new Error(
            `Failed to create broadcast: ${createErr?.message ?? 'unknown error'}`,
          );
        }
        broadcastId = created.id;
      }

      // ── Step 4: Insert recipient rows ─────────────────────────────
      setProgress(25);
      const paramsByContact = new Map(
        contacts.map((contact) => [
          contact.id,
          resolveVariables(
            payload.variables,
            contact,
            customValueIndex.get(contact.id),
            payload.missingValuePolicy,
            payload.fallbackValue,
          ),
        ]),
      );

      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcastId!,
        contact_id: contact.id,
        status: 'pending' as const,
        template_params: paramsByContact.get(contact.id) ?? [],
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcastId);
          throw new Error(
            `Failed to insert recipient batch: ${recipientError.message}`,
          );
        }
      }

      // ── Step 5: Fetch recipients back & run send loop ─────────────
      setProgress(30);
      const { data: recipients, error: recipientsFetchError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId);

      if (recipientsFetchError || !recipients) {
        throw new Error('Failed to fetch broadcast recipients');
      }

      let failedCount = 0;
      const totalRecipients = recipients.length;

      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();
      const messageParams =
        isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            phone: r.contact!.phone as string,
            params: Array.isArray(r.template_params) ? r.template_params : [],
            ...(messageParams ? { messageParams } : {}),
          }));

        if (apiRecipients.length === 0) continue;

        try {
          let data: { error?: string; results?: BroadcastApiResult[] } = {};
          for (let attempt = 1; ; attempt++) {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
              }),
            });

            data = await res.json();
            if (res.ok) break;

            const retryIn =
              attempt < BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
                : null;
            if (retryIn === null) {
              throw new Error(data.error || 'Broadcast API request failed');
            }
            await sleep(retryIn);
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: 'No phone number on contact',
                })
                .eq('id', recipient.id);
              continue;
            }

            if (result.status === 'sent') {
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'sent',
                  sent_at: new Date().toISOString(),
                  whatsapp_message_id: result.whatsapp_message_id ?? null,
                  error_message: null,
                })
                .eq('id', recipient.id);
            } else {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: result.error ?? 'Unknown error',
                })
                .eq('id', recipient.id);
            }
          }
        } catch (err) {
          for (const recipient of batch) {
            failedCount++;
            await supabase
              .from('broadcast_recipients')
              .update({
                status: 'failed',
                error_message: err instanceof Error ? err.message : 'Unknown error',
              })
              .eq('id', recipient.id);
          }
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 6: Finalize status ───────────────────────────────────
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await supabase
        .from('broadcasts')
        .update({ status: finalStatus, updated_at: new Date().toISOString() })
        .eq('id', broadcastId);

      setProgress(100);
      return broadcastId!;
    } finally {
      setIsProcessing(false);
    }
  }

  return {
    createAndSendBroadcast,
    scheduleBroadcast,
    saveDraftBroadcast,
    isProcessing,
    progress,
  };
}
