// ============================================================
// GET /api/whatsapp/broadcast/cron
//
// Background cron runner for scheduled WhatsApp broadcasts.
//
// Automatically sweeps and executes broadcasts where:
//   - status = 'scheduled'
//   - scheduled_at <= NOW()
//   - delivery_locked_at IS NULL (or stale beyond DELIVERY_LOCK_STALE_MS)
//
// Security & Idempotency:
//   - Requires matching x-cron-secret header against AUTOMATION_CRON_SECRET
//     using constant-time comparison (timingSafeEqual).
//   - Atomically claims rows via delivery_locked_at mutex so overlapping
//     cron runs cannot double-execute the same broadcast.
//   - Delivers server-side via planBroadcastResume + deliverBroadcast,
//     surviving browser close and server restart.
// ============================================================

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';

// Up to 1 000 recipients per execution pass
export const maxDuration = 300;

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }

  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const now = new Date();

  // Find due scheduled broadcasts
  const { data: dueBroadcasts, error } = await admin
    .from('broadcasts')
    .select('id, account_id, name, template_name, scheduled_at')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(10);

  if (error) {
    console.error('[broadcast-cron] fetch error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!dueBroadcasts || dueBroadcasts.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  let processed = 0;
  const results: Array<{ id: string; name: string; status: string; count?: number; error?: string }> = [];

  for (const b of dueBroadcasts) {
    // 1. Atomic claim using delivery mutex
    const claimed = await claimBroadcastDelivery(admin, b.account_id, b.id, now);
    if (!claimed) {
      continue;
    }

    try {
      // 2. Mark sending
      await admin
        .from('broadcasts')
        .update({
          status: 'sending',
          updated_at: new Date().toISOString(),
        })
        .eq('id', b.id);

      // 3. Plan resume delivery (all pending recipients)
      const { plan } = await planBroadcastResume(
        admin,
        b.account_id,
        b.id,
        'pending',
      );

      // 4. Deliver via Meta API
      await deliverBroadcast(admin, plan);

      results.push({
        id: b.id,
        name: b.name,
        status: 'delivered',
        count: plan.planned.length,
      });
      processed++;
    } catch (err) {
      console.error(
        `[broadcast-cron] delivery failed for broadcast ${b.id}:`,
        err instanceof Error ? err.message : err,
      );
      await finalizeBroadcastStatus(admin, b.id).catch(() => {});
      results.push({
        id: b.id,
        name: b.name,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unknown delivery error',
      });
    } finally {
      await releaseBroadcastDelivery(admin, b.id);
    }
  }

  return NextResponse.json({
    processed,
    results,
  });
}
