// ============================================================
// /api/whatsapp/broadcast/[id]
//
// PATCH  — Update draft / edit schedule / cancel schedule.
// DELETE — Delete draft or scheduled broadcast.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    const body = await request.json().catch(() => ({}));

    // Find the broadcast on this account
    const { data: bc, error: fetchErr } = await supabase
      .from('broadcasts')
      .select('id, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .single();

    if (fetchErr || !bc) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    if (bc.status === 'sending') {
      return NextResponse.json(
        { error: 'Cannot modify a broadcast that is currently sending' },
        { status: 400 },
      );
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.action === 'cancel_schedule') {
      updates.status = 'draft';
      updates.scheduled_at = null;
    } else if (body.action === 'update_schedule') {
      if (!body.scheduled_at) {
        return NextResponse.json(
          { error: 'scheduled_at is required to update schedule' },
          { status: 400 },
        );
      }
      updates.status = 'scheduled';
      updates.scheduled_at = body.scheduled_at;
      if (body.timezone) updates.timezone = body.timezone;
    } else {
      // General field patch (e.g. name, audience_filter, template_variables)
      if (typeof body.name === 'string') updates.name = body.name.trim();
      if (body.audience_filter) updates.audience_filter = body.audience_filter;
      if (body.template_variables) updates.template_variables = body.template_variables;
      if (body.header_media_url !== undefined) {
        updates.header_media_url = body.header_media_url ? body.header_media_url.trim() : null;
      }
      if (body.scheduled_at !== undefined) updates.scheduled_at = body.scheduled_at;
      if (body.timezone !== undefined) updates.timezone = body.timezone;
      if (body.status !== undefined) updates.status = body.status;
    }

    const { data: updated, error: updateErr } = await supabase
      .from('broadcasts')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single();

    if (updateErr) {
      return NextResponse.json(
        { error: `Failed to update broadcast: ${updateErr.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, broadcast: updated });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;

    const { data: bc, error: fetchErr } = await supabase
      .from('broadcasts')
      .select('id, status')
      .eq('id', id)
      .eq('account_id', accountId)
      .single();

    if (fetchErr || !bc) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 });
    }

    if (bc.status === 'sending') {
      return NextResponse.json(
        { error: 'Cannot delete a broadcast that is currently sending' },
        { status: 400 },
      );
    }

    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);

    if (delErr) {
      return NextResponse.json(
        { error: `Failed to delete broadcast: ${delErr.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, deleted: id });
  } catch (error) {
    return toErrorResponse(error);
  }
}
