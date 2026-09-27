import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { deliverBroadcast } from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';
import { GET } from './route';

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  deliverBroadcast: vi.fn(),
  finalizeBroadcastStatus: vi.fn(),
}));

vi.mock('@/lib/whatsapp/broadcast-resume', () => ({
  claimBroadcastDelivery: vi.fn(),
  planBroadcastResume: vi.fn(),
  releaseBroadcastDelivery: vi.fn(),
}));

describe('GET /api/whatsapp/broadcast/cron', () => {
  const originalSecret = process.env.AUTOMATION_CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTOMATION_CRON_SECRET = 'test-cron-secret';
  });

  afterEach(() => {
    process.env.AUTOMATION_CRON_SECRET = originalSecret;
  });

  it('returns 503 when AUTOMATION_CRON_SECRET is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    const req = new Request('http://localhost/api/whatsapp/broadcast/cron');
    const res = await GET(req);
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe('cron not configured');
  });

  it('returns 401 when x-cron-secret header does not match', async () => {
    const req = new Request('http://localhost/api/whatsapp/broadcast/cron', {
      headers: { 'x-cron-secret': 'wrong-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it('returns processed: 0 when no broadcasts are due', async () => {
    const mockClient = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        lte: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    };
    vi.mocked(supabaseAdmin).mockReturnValue(mockClient as unknown as SupabaseClient);

    const req = new Request('http://localhost/api/whatsapp/broadcast/cron', {
      headers: { 'x-cron-secret': 'test-cron-secret' },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.processed).toBe(0);
  });

  it('claims, marks sending, and delivers due scheduled broadcasts', async () => {
    const mockBroadcast = {
      id: 'bc-1',
      account_id: 'acc-1',
      name: 'Spring Offer',
      template_name: 'spring_promo',
      scheduled_at: new Date(Date.now() - 1000).toISOString(),
    };

    const mockUpdate = vi.fn().mockReturnThis();
    const mockEq = vi.fn().mockResolvedValue({ error: null });

    const mockClient = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'broadcasts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            lte: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [mockBroadcast], error: null }),
            update: mockUpdate.mockReturnValue({ eq: mockEq }),
          };
        }
        return {};
      }),
    };

    vi.mocked(supabaseAdmin).mockReturnValue(mockClient as unknown as SupabaseClient);
    vi.mocked(claimBroadcastDelivery).mockResolvedValue(true);
    vi.mocked(planBroadcastResume).mockResolvedValue({
      plan: {
        broadcastId: 'bc-1',
        templateName: 'spring_promo',
        templateLanguage: 'en_US',
        phoneNumberId: 'phone-123',
        accessToken: 'token-abc',
        templateRow: null,
        planned: [{ recipientRowId: 'r-1', phone: '+1234567890', params: [] }],
        rejected: 0,
      },
      remaining: 0,
      unsendable: 0,
    });
    vi.mocked(deliverBroadcast).mockResolvedValue(undefined);
    vi.mocked(releaseBroadcastDelivery).mockResolvedValue(undefined);

    const req = new Request('http://localhost/api/whatsapp/broadcast/cron', {
      headers: { 'x-cron-secret': 'test-cron-secret' },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.processed).toBe(1);
    expect(json.results[0].status).toBe('delivered');
    expect(claimBroadcastDelivery).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      'bc-1',
      expect.any(Date),
    );
    expect(deliverBroadcast).toHaveBeenCalled();
    expect(releaseBroadcastDelivery).toHaveBeenCalledWith(expect.anything(), 'bc-1');
  });
});
