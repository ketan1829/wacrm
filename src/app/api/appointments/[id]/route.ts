import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { canTransitionStatus } from "@/lib/appointments/status";
import type { AppointmentStatus } from "@/lib/appointments/types";

/**
 * GET /api/appointments/[id] — get appointment details with relations.
 * PATCH /api/appointments/[id] — update appointment (status, notes, customer details).
 * DELETE /api/appointments/[id] — delete appointment (admin only).
 */

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await getCurrentAccount();

    const { data: appointment, error } = await ctx.supabase
      .from("appointments")
      .select("*, service:appointment_services(*), staff:appointment_staff(*), contact:contacts(*), calendar_links:appointment_calendar_links(*)")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!appointment) {
      return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    }

    return NextResponse.json({ appointment });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("agent");
    const body = await request.json();

    const allowedFields = ["status", "notes", "customer_name", "customer_phone"];
    const updates: Record<string, unknown> = {};

    for (const key of allowedFields) {
      if (body[key] !== undefined) {
        updates[key] = body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    // If status is being changed, validate transition rule
    if (updates.status) {
      const { data: currentApp } = await ctx.supabase
        .from("appointments")
        .select("status")
        .eq("id", id)
        .eq("account_id", ctx.accountId)
        .single();

      if (!currentApp) {
        return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
      }

      if (!canTransitionStatus(currentApp.status as AppointmentStatus, updates.status as AppointmentStatus)) {
        return NextResponse.json(
          {
            error: `Invalid status transition from ${currentApp.status} to ${updates.status}`,
            code: "INVALID_STATUS_TRANSITION",
          },
          { status: 400 },
        );
      }
    }

    const { data: updated, error } = await ctx.supabase
      .from("appointments")
      .update(updates)
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("*, service:appointment_services(*), staff:appointment_staff(*), contact:contacts(*), calendar_links:appointment_calendar_links(*)")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ appointment: updated });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const ctx = await requireRole("admin");

    const { error } = await ctx.supabase
      .from("appointments")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
